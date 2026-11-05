import {NextRequest} from "next/server";
import {publishResults} from "@musical-daily/accounts/server";
import {flushAccountResults} from "@/lib/account-results";
import {catalogStatus,loadCatalog} from "@/lib/catalog";
import {act,createGame,publicGame} from "@/lib/engine";
import {anonymousIdentity,identity,readBody,reply,errorReply} from "@/lib/http";
import {findGame,findRequest,historyFor,rateLimit,saveGame,settleSavedGame,store,transaction} from "@/lib/store";
import {METRICS} from "@/lib/rules";
import type {MetricFilter,Move,Side} from "@/lib/types";
import {personalBest} from "@/lib/records";
import {validBankTarget,type BankTarget} from "@/lib/run-goals";

export const runtime="nodejs";export const dynamic="force-dynamic";
function availableCatalog(version?:string){try{return loadCatalog(version);}catch{throw Object.assign(new Error("The saved collection is temporarily unavailable. Please retry."),{status:503});}}
export async function GET(req:NextRequest){
  const {token}=anonymousIdentity(req);
  try{
    const {player}=await identity(req,token);const db=store();rateLimit(db,player,"read",180);
    const game=transaction(db,()=>settleSavedGame(db,findGame(db,player)));
    const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));
    return reply({game:game?publicGame(game):null,catalog:catalogStatus(),personalBest:personalBest(db,player),statsSynced},token);
  }catch(error){return errorReply(Object.assign(new Error("Unable to load this run."),{status:error&&typeof error==="object"&&"status" in error?error.status:503}),token);}
}
export async function POST(req:NextRequest){
  const {token}=anonymousIdentity(req);
  try{
    const {player}=await identity(req,token);const body=await readBody(req);const db=store();rateLimit(db,player,"moves",120);
    if(body.action==="create"){
      if(!validBankTarget(body.bankTarget))throw new Error("Choose one of the available bank targets.");
      if(typeof body.requestId!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)||body.theme!==undefined&&(typeof body.theme!=="string"||body.theme.length>150)||body.catalogVersion!==undefined&&(typeof body.catalogVersion!=="string"||!/^[a-f0-9]{16}$/.test(body.catalogVersion))||body.metricFilter!==undefined&&(typeof body.metricFilter!=="string"||!(body.metricFilter==="mixed"||METRICS.includes(body.metricFilter as Exclude<MetricFilter,"mixed">))))throw new Error("Choose a valid collection and start again.");
      const existing=transaction(db,()=>{
        const prior=settleSavedGame(db,findRequest(db,player,body.requestId as string));if(prior)return prior;
        const active=settleSavedGame(db,findGame(db,player));return active&&active.phase!=="complete"?active:null;
      });
      if(existing){const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));return reply({game:publicGame(existing),personalBest:personalBest(db,player),statsSynced},token);}
      rateLimit(db,player,"create",12);
      const catalog=availableCatalog(body.catalogVersion as string|undefined);
      const game=transaction(db,()=>{
        // A retried create or two simultaneous tabs must never open competing runs.
        const duplicate=settleSavedGame(db,findRequest(db,player,body.requestId as string));if(duplicate)return duplicate;
        const latest=settleSavedGame(db,findGame(db,player));if(latest&&latest.phase!=="complete")return latest;
        const created=createGame(player,catalog,body.requestId as string,{theme:body.theme as string|undefined,metricFilter:body.metricFilter as MetricFilter|undefined,bankTarget:body.bankTarget as BankTarget|null|undefined,bestBankToBeat:personalBest(db,player)},Date.now(),historyFor(db,player));saveGame(db,created);return created;
      });
      const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events));
      return reply({game:publicGame(game),personalBest:personalBest(db,player),statsSynced},token);
    }
    if(typeof body.gameId!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(body.gameId)||!Number.isSafeInteger(body.round)||(body.round as number)<0||!Number.isSafeInteger(body.revision)||(body.revision as number)<0||typeof body.action!=="string"||!["guess","timeout","bank","risk","next","cashout","discard"].includes(body.action)||body.action==="guess"&&body.choice!=="left"&&body.choice!=="right")throw new Error("Invalid game action. Reload your saved run and retry.");
    const result=transaction(db,()=>{
      const game=findGame(db,player,body.gameId as string);if(!game)throw Object.assign(new Error("This run belongs to another browser or has expired."),{status:404});
      const revision=game.revision;
      settleSavedGame(db,game);
      // Replays return the current state before any catalog lookup or transition.
      if(game.revision!==revision||game.round!==body.round||game.revision!==body.revision||game.phase==="complete")return {game:publicGame(game),stale:true};
      const catalog=["bank","risk","next"].includes(body.action as string)?availableCatalog(game.catalogVersion):undefined;
      const state=act(game,body.action as Move,body.round as number,body.revision as number,body.choice as Side|undefined,catalog);
      if(game.revision!==revision)saveGame(db,game,revision);
      return state;
    });
    const statsSynced=result.game.phase==="complete"?await flushAccountResults(db,player,events=>publishResults(req,"double-drop",events)):undefined;
    return reply({...result,personalBest:personalBest(db,player),statsSynced},token);
  }catch(error){return errorReply(error,token);}
}
