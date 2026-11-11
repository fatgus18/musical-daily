import {NextRequest} from "next/server";
import {publishResults} from "@musical-daily/accounts/server";
import {flushAccountResults} from "@/lib/account-results";
import {loadArtist} from "@/lib/catalog";
import {publicGame,replaceClip,expireGuess} from "@/lib/engine";
import {applySavedMove,validateGameMove} from "@/lib/game-moves";
import {trackIdentity,catalogOffer} from "@/lib/rules";
import {ensureChoices} from "@/lib/choices";
import {audioEnabled,identity,anonymousIdentity,readBody,reply,errorReply} from "@/lib/http";
import {findGame,historyFor,rateLimit,startMix,saveGame,store,transaction} from "@/lib/store";
export const runtime="nodejs";export const dynamic="force-dynamic";

export async function GET(req:NextRequest){
  let {token}=anonymousIdentity(req);
  try{
    const authenticated=await identity(req,token);token=authenticated.token;const {player}=authenticated;const db=await store();
    const state=await transaction(db,async tx=>{
      const game=await findGame(tx,player);if(!game||!audioEnabled())return null;
      ensureChoices(game);expireGuess(game);await saveGame(tx,game);return publicGame(game);
    });
    const statsSynced=state&&["guessing","listening"].includes(state.phase)?undefined:await flushAccountResults(db,player,events=>publishResults(req,"encore",events));
    return reply({game:state,audioEnabled:audioEnabled(),statsSynced},token);
  }catch{return reply({error:"Your mix couldn't load. Please retry."},token,503);}
}

export async function POST(req:NextRequest){
  let {token}=anonymousIdentity(req);
  try{
    const authenticated=await identity(req,token);token=authenticated.token;const {player}=authenticated;const body=await readBody(req);
    if(!audioEnabled()&&!["discard","sync"].includes(body.action))return reply({error:"Audio games are not enabled on this deployment yet."},token,503);
    const db=await store();await rateLimit(db,player,"moves",120);
    if(body.action==="create"){
      if(typeof body.artistId!=="string"||body.artistId.length>40||typeof body.requestId!=="string"||!(/^[a-zA-Z0-9-]{16,80}$/).test(body.requestId))throw new Error("Choose an artist and try again.");
      // Avoid a provider request on a retry. Re-read under the write lock before returning.
      const previous=(await db.execute("SELECT id FROM games WHERE player=? AND request_id=?",[player,body.requestId])).rows[0];
      if(previous){
        const state=await transaction(db,async tx=>{
          const saved=await findGame(tx,player,String(previous.id));if(!saved)return null;
          ensureChoices(saved);expireGuess(saved);await saveGame(tx,saved);return publicGame(saved);
        });
        if(state)return reply({game:state},token);
      }
      if(body.mode!==undefined&&!['ranked','discovery'].includes(body.mode))throw new Error("Choose a valid mix type.");
      await rateLimit(db,player,"create",8);const pool=await loadArtist(body.artistId);const offer=catalogOffer(pool);const mode=body.mode||"ranked";
      if(mode==="ranked"&&!offer.rankedAvailable||mode==="discovery"&&!offer.discoveryAvailable)return reply({offer},token);
      const game=await startMix(db,player,pool,body.requestId,Date.now(),mode);
      const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"encore",events));
      return reply({game:publicGame(game),statsSynced},token);
    }
    const move=validateGameMove(body);
    if(move.action==="replace-clip"){
      if(typeof body.expectedPreview!=="string"||body.expectedPreview.length>1500||(body.expectedListenAt!==null&&!Number.isFinite(body.expectedListenAt)))throw new Error("Reconnect to your current clip before replacing it.");
      const saved=await findGame(db,player,move.gameId);if(!saved)throw new Error("Mix not found in this browser.");
      const pool=await loadArtist(saved.artist.id);
      const state=await transaction(db,async tx=>{
        const game=await findGame(tx,player,move.gameId);if(!game)throw new Error("Mix not found in this browser.");
        if(game.round!==move.round||game.picks[game.round].track.preview!==body.expectedPreview||game.listenAt!==body.expectedListenAt)return publicGame(game);
        const replacement=replaceClip(game,pool,await historyFor(tx,player,game.artist.id));
        await tx.execute("INSERT INTO exposures VALUES(?,?,?,1,?) ON CONFLICT(player,artist,track) DO UPDATE SET plays=plays+1,last_played=excluded.last_played",[player,game.artist.id,trackIdentity(replacement),Date.now()]);
        await saveGame(tx,game);return publicGame(game);
      });
      return reply({game:state},token);
    }
    const state=await applySavedMove(db,player,body);
    const statsSynced=["guessing","listening"].includes(state.phase)?undefined:await flushAccountResults(db,player,events=>publishResults(req,"encore",events));
    return reply({game:state,statsSynced},token);
  }catch(e){return errorReply(e,token);}
}
