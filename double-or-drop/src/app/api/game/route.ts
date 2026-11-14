import {NextRequest} from "next/server";
import {publishResults} from "@musical-daily/accounts/server";
import {flushAccountResults} from "@/lib/account-results";
import {catalogStatus,type Catalog} from "@/lib/catalog";
import {loadSavedCatalog,pinCatalog} from "@/lib/catalog-storage";
import {act,createGame,createDailyGame,publicGame} from "@/lib/engine";
import {dailyReset,ensureDailyChallenge,findDailyGame,utcDate} from "@/lib/daily";
import {anonymousIdentity,identity,readBody,reply,errorReply} from "@/lib/http";
import {findGame,findModeGame,findRequest,historyFor,rateLimit,readModeGame,saveGame,settleSavedGame,store,transaction} from "@/lib/store";
import {METRICS} from "@/lib/rules";
import type {MetricFilter,Move,Side} from "@/lib/types";
import {personalBest} from "@/lib/records";
import {validBankTarget,type BankTarget} from "@/lib/run-goals";

export const runtime="nodejs";export const dynamic="force-dynamic";
async function availableCatalog(version?:string){try{return await loadSavedCatalog(version);}catch{throw Object.assign(new Error("The saved collection is temporarily unavailable. Please retry."),{status:503});}}
export async function GET(req:NextRequest){
  let {token}=anonymousIdentity(req);
  try{
    const authenticated=await identity(req,token);token=authenticated.token;const {player}=authenticated;const db=await store();await rateLimit(db,player,"read",180);
    const mode=req.nextUrl.searchParams.get("mode")||"unlimited";
    if(mode!=="daily"&&mode!=="unlimited")throw Object.assign(new Error("Choose daily or unlimited."),{status:400});
    const date=utcDate();
    const game=await readModeGame(db,player,mode,date);
    const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));
    return reply({game:game?publicGame(game):null,catalog:catalogStatus(),daily:{date,resetsAt:dailyReset(date)},personalBest:await personalBest(db,player),statsSynced},token);
  }catch(error){return errorReply(Object.assign(new Error("Unable to load this run."),{status:error&&typeof error==="object"&&"status" in error?error.status:503}),token);}
}
export async function POST(req:NextRequest){
  let {token}=anonymousIdentity(req);
  try{
    const authenticated=await identity(req,token);token=authenticated.token;const {player}=authenticated;const body=await readBody(req);const db=await store();await rateLimit(db,player,"moves",120);
    if(body.action==="create"){
      if(body.mode!==undefined&&body.mode!=="daily"&&body.mode!=="unlimited")throw new Error("Choose daily or unlimited.");
      if(!validBankTarget(body.bankTarget))throw new Error("Choose one of the available bank targets.");
      if(typeof body.requestId!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)||body.theme!==undefined&&(typeof body.theme!=="string"||body.theme.length>150)||body.catalogVersion!==undefined&&(typeof body.catalogVersion!=="string"||!/^[a-f0-9]{16}$/.test(body.catalogVersion))||body.metricFilter!==undefined&&(typeof body.metricFilter!=="string"||!(body.metricFilter==="mixed"||METRICS.includes(body.metricFilter as Exclude<MetricFilter,"mixed">))))throw new Error("Choose a valid collection and start again.");
      if(body.mode==="daily"){
        if(["date","seed","dailyDate","theme","metricFilter","catalogVersion","bankTarget"].some(key=>body[key]!==undefined))throw new Error("The daily mix is chosen for everyone. Start it without custom settings.");
        const date=utcDate();
        const prior=await transaction(db,async tx=>{
          await settleSavedGame(tx,await findModeGame(tx,player,"daily"));
          return settleSavedGame(tx,await findDailyGame(tx,player,date));
        });
        if(prior)return reply({game:publicGame(prior),daily:{date,resetsAt:dailyReset(date)}},token);
        await rateLimit(db,player,"create",12);
        const challenge=await ensureDailyChallenge(db,await availableCatalog(),date);
        const game=await transaction(db,async tx=>{
          if(utcDate()!==date)throw Object.assign(new Error("A fresh daily mix just arrived. Please try again."),{status:409});
          await settleSavedGame(tx,await findModeGame(tx,player,"daily"));
          const existing=await findDailyGame(tx,player,date);if(existing)return existing;
          if(await findRequest(tx,player,body.requestId as string))throw new Error("Start this daily mix with a fresh request.");
          const created=createDailyGame(player,challenge,body.requestId as string);
          await saveGame(tx,created);return created;
        });
        const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));
        return reply({game:publicGame(game),daily:{date,resetsAt:dailyReset(date)},statsSynced},token);
      }
      const existing=await transaction(db,async tx=>{
        const prior=await settleSavedGame(tx,await findRequest(tx,player,body.requestId as string));if(prior)return prior;
        const active=await settleSavedGame(tx,await findModeGame(tx,player,"unlimited"));return active&&active.phase!=="complete"?active:null;
      });
      if(existing){const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));return reply({game:publicGame(existing),personalBest:await personalBest(db,player),statsSynced},token);}
      await rateLimit(db,player,"create",12);
      // Snapshot reads can take network time and must happen before the write lease.
      const catalog=await availableCatalog(body.catalogVersion as string|undefined);
      const game=await transaction(db,async tx=>{
        const duplicate=await settleSavedGame(tx,await findRequest(tx,player,body.requestId as string));if(duplicate)return duplicate;
        const latest=await settleSavedGame(tx,await findModeGame(tx,player,"unlimited"));if(latest&&latest.phase!=="complete")return latest;
        await pinCatalog(tx,catalog);
        const bestBankToBeat=await personalBest(tx,player),history=await historyFor(tx,player);
        const created=createGame(player,catalog,body.requestId as string,{theme:body.theme as string|undefined,metricFilter:body.metricFilter as MetricFilter|undefined,bankTarget:body.bankTarget as BankTarget|null|undefined,bestBankToBeat},Date.now(),history);
        await saveGame(tx,created);return created;
      });
      const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));
      return reply({game:publicGame(game),personalBest:await personalBest(db,player),statsSynced},token);
    }
    if(typeof body.gameId!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(body.gameId)||!Number.isSafeInteger(body.round)||(body.round as number)<0||!Number.isSafeInteger(body.revision)||(body.revision as number)<0||typeof body.action!=="string"||!["guess","timeout","bank","risk","next","cashout","discard"].includes(body.action)||body.action==="guess"&&body.choice!=="left"&&body.choice!=="right")throw new Error("Invalid game action. Reload your saved run and retry.");
    let catalog:Catalog|undefined,catalogError:unknown;
    if(["bank","risk","next"].includes(body.action)){
      const snapshot=await findGame(db,player,body.gameId);
      if(snapshot&&snapshot.mode!=="daily"&&snapshot.phase!=="complete"&&snapshot.round===body.round&&snapshot.revision===body.revision){
        try{catalog=await availableCatalog(snapshot.catalogVersion);}catch(error){catalogError=error;}
      }
    }
    const result=await transaction(db,async tx=>{
      const game=await findGame(tx,player,body.gameId as string);if(!game)throw Object.assign(new Error("This run belongs to another browser or has expired."),{status:404});
      const revision=game.revision;await settleSavedGame(tx,game);
      // Idempotent replays still succeed even if a catalog provider is unavailable.
      if(game.revision!==revision||game.round!==body.round||game.revision!==body.revision||game.phase==="complete")return {game:publicGame(game),stale:true};
      if(catalogError)throw catalogError;
      const state=act(game,body.action as Move,body.round as number,body.revision as number,body.choice as Side|undefined,catalog);
      if(game.revision!==revision)await saveGame(tx,game,revision);
      return state;
    });
    const statsSynced=result.game.phase==="complete"?await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events)):undefined;
    return reply({...result,personalBest:await personalBest(db,player),statsSynced},token);
  }catch(error){return errorReply(error,token);}
}
