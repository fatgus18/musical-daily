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
export async function GET(req:NextRequest){const {token}=anonymousIdentity(req);try{const {player}=await identity(req,token);const db=store();const state=transaction(db,()=>{const game=findGame(db,player);if(!game||!audioEnabled())return null;ensureChoices(game);expireGuess(game);saveGame(db,game);return publicGame(game);});const statsSynced=state&&["guessing","listening"].includes(state.phase)?undefined:await flushAccountResults(db,player,events=>publishResults(req,"encore",events));return reply({game:state,audioEnabled:audioEnabled(),statsSynced},token);}catch{return reply({error:"Your mix couldn't load. Please retry."},token,503);}}
export async function POST(req:NextRequest){const {token}=anonymousIdentity(req);try{const {player}=await identity(req,token);
  const body=await readBody(req);
  if(!audioEnabled()&&!["discard","sync"].includes(body.action))return reply({error:"Audio games are not enabled on this deployment yet."},token,503);
  const db=store();rateLimit(db,player,"moves",120);
  if(body.action==="create"){
    if(typeof body.artistId!=="string"||body.artistId.length>40||typeof body.requestId!=="string"||!(/^[a-zA-Z0-9-]{16,80}$/).test(body.requestId))throw new Error("Choose an artist and try again.");
    const previous=db.prepare("SELECT state FROM games WHERE player=? AND request_id=?").get(player,body.requestId);if(previous){const state=transaction(db,()=>{const saved=findGame(db,player,JSON.parse(String(previous.state)).id)!;ensureChoices(saved);expireGuess(saved);saveGame(db,saved);return publicGame(saved);});return reply({game:state},token);}
    if(body.mode!==undefined&&!['ranked','discovery'].includes(body.mode))throw new Error("Choose a valid mix type.");
    rateLimit(db,player,"create",8);const pool=await loadArtist(body.artistId);const offer=catalogOffer(pool);const mode=body.mode||"ranked";
    if(mode==="ranked"&&!offer.rankedAvailable||mode==="discovery"&&!offer.discoveryAvailable)return reply({offer},token);
    const game=startMix(db,player,pool,body.requestId,Date.now(),mode);
    const statsSynced=await flushAccountResults(db,player,events=>publishResults(req,"encore",events));
    return reply({game:publicGame(game),statsSynced},token);
  }
  validateGameMove(body);
  if(body.action==="replace-clip"){
    if(typeof body.expectedPreview!=="string"||body.expectedPreview.length>1500||(body.expectedListenAt!==null&&!Number.isFinite(body.expectedListenAt)))throw new Error("Reconnect to your current clip before replacing it.");
    const saved=findGame(db,player,body.gameId);if(!saved)throw new Error("Mix not found in this browser.");
    const pool=await loadArtist(saved.artist.id);const state=transaction(db,()=>{const game=findGame(db,player,body.gameId)!;if(game.round!==body.round||game.picks[game.round].track.preview!==body.expectedPreview||game.listenAt!==body.expectedListenAt)return publicGame(game);const replacement=replaceClip(game,pool,historyFor(db,player,game.artist.id));db.prepare("INSERT INTO exposures VALUES(?,?,?,1,?) ON CONFLICT(player,artist,track) DO UPDATE SET plays=plays+1,last_played=excluded.last_played").run(player,game.artist.id,trackIdentity(replacement),Date.now());saveGame(db,game);return publicGame(game);});return reply({game:state},token);
  }
  const state=applySavedMove(db,player,body);const statsSynced=["guessing","listening"].includes(state.phase)?undefined:await flushAccountResults(db,player,events=>publishResults(req,"encore",events));return reply({game:state,statsSynced},token);
}catch(e){return errorReply(e,token);}}
