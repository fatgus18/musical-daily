import {randomUUID,createHash} from "node:crypto";
import type {ArtistPool} from "./catalog.ts";
import type {Exposure,Game,PublicGame,MixMode,IncompleteReason} from "./types.ts";
import {CLIP_OFFSET,CLIP_SECONDS,GUESS_SECONDS,selectMix,tierPools,trackIdentity,selectDiscovery,discoverySongs} from "./rules.ts";
import {ensureChoices,withChoices} from "./choices.ts";
import {isAssisted,useFiftyFifty,visibleChoices} from "./lifeline.ts";
function rankingFingerprint(pool:ArtistPool){return createHash("sha256").update(JSON.stringify([pool.ranking.kind,pool.ranking.sourceUrl,pool.ranking.asOf,pool.tracks.map(t=>[trackIdentity(t),t.rank]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))] )).digest("hex");}
export function createGame(player:string,pool:ArtistPool,history:Exposure[],requestId:string,now=Date.now(),mode:MixMode="ranked"):Game{
  const id=randomUUID();if(mode==="ranked"&&pool.ranking.kind==="unranked")throw new Error("Choose a discovery mix when popularity data is unavailable.");
  const songs=mode==="discovery"?discoverySongs(pool):pool.tracks;
  const selected=mode==="discovery"?selectDiscovery(songs,history,id):selectMix(songs,history,id);const avoid=new Set(selected.map(p=>trackIdentity(p.track)));
  const picks=selected.map((pick,round)=>withChoices(pick,discoverySongs(pool),`${id}:${round}`,avoid));
  return {id,player,artist:pool.artist,ranking:mode==="discovery"?{kind:"unranked",label:"Discovery mix · no popularity tiers",sourceUrl:pool.artist.url,asOf:new Date(pool.fetchedAt).toISOString().slice(0,10)}:pool.ranking,mode,poolSize:songs.length,coverage:pool.coverage,rankingFingerprint:mode==="ranked"?rankingFingerprint(pool):undefined,picks,round:0,phase:"ready",results:[],listenAt:null,createdAt:now,completedAt:null,requestId};
}
export function publicGame(game:Game,now=Date.now()):PublicGame{return {id:game.id,artist:game.artist,ranking:game.ranking,mode:game.mode||"ranked",poolSize:game.poolSize,coverage:game.coverage,round:game.round,phase:game.phase,completionStatus:game.completionStatus??(game.results.length===10?"completed":undefined),incompleteReason:game.incompleteReason,lifeline:{used:!!game.fiftyFifty,round:game.fiftyFifty?.round??null,active:game.phase==="guessing"&&isAssisted(game)},results:game.results,correct:game.results.filter(r=>r.correct).length,tier:game.picks[game.round].tier,listenAt:game.listenAt,guessDeadline:game.guessDeadline??null,serverNow:now,clipOffset:CLIP_OFFSET,clipSeconds:CLIP_SECONDS,mixCounts:{hit:game.picks.filter(p=>p.tier==="hit").length,favorite:game.picks.filter(p=>p.tier==="favorite").length,deep:game.picks.filter(p=>p.tier==="deep").length},...(game.phase==="guessing"?{choices:visibleChoices(game)?.map(({id,label})=>({id,label}))}:{}),...(["ready","listening","guessing"].includes(game.phase)?{preview:game.picks[game.round].track.preview}:{})};}
export function expireGuess(game:Game,now=Date.now()){
  if(game.phase!=="guessing")return false;
  // Existing untimed saved rounds get one full window on their first reconciliation.
  if(game.guessDeadline==null){game.guessDeadline=now+GUESS_SECONDS*1000;return false;}
  if(now<game.guessDeadline)return false;
  const pick=game.picks[game.round];game.results.push({round:game.round,title:pick.track.title,artist:pick.track.artist,artwork:pick.track.artwork,url:pick.track.url,tier:pick.tier,input:"",correct:false,skipped:false,timedOut:true,...(isAssisted(game)?{assisted:true}:{})});game.phase="reveal";if(game.round===9)game.completedAt=now;return true;
}
export function replaceClip(game:Game,pool:ArtistPool,history:Exposure[]){
  ensureChoices(game);
  if(!["ready","listening"].includes(game.phase))throw new Error("Only an unheard clip can be replaced.");
  if((game.replaced?.length||0)>=5)throw new Error("Several previews aren't working. Please try another artist or return later.");
  if(game.mode!=="discovery"&&(pool.ranking.kind!==game.ranking.kind||pool.ranking.asOf!==game.ranking.asOf||pool.ranking.sourceUrl!==game.ranking.sourceUrl||game.rankingFingerprint&&game.rankingFingerprint!==rankingFingerprint(pool)))throw new Error("This catalog has refreshed. Start a new mix for the updated collection.");
  const tier=game.picks[game.round].tier;const used=new Set([...game.picks.map(p=>trackIdentity(p.track)),...(game.replaced||[])]);
  const seen=new Map(history.map(h=>[h.id,h]));
  const candidates=tier==="discovery"?discoverySongs(pool):tierPools(pool.tracks).find(t=>t[0]===tier)![1];
  const replacement=candidates.filter(t=>!used.has(trackIdentity(t))).sort((a,b)=>(seen.get(trackIdentity(a))?.plays||0)-(seen.get(trackIdentity(b))?.plays||0)||(seen.get(trackIdentity(a))?.lastPlayed||0)-(seen.get(trackIdentity(b))?.lastPlayed||0))[0];
  if(!replacement)throw new Error("No unused replacement at this level is available. Retry the preview or start another mix.");
  const replacementPick=withChoices({track:replacement,tier},discoverySongs(pool),`${game.id}:${game.round}:${replacement.id}`,used);
  game.replaced=[...(game.replaced||[]),trackIdentity(game.picks[game.round].track)];game.picks[game.round]=replacementPick;game.phase="ready";game.listenAt=null;return replacement;
}
export function act(game:Game,action:string,round:number,input="",now=Date.now()){
  if(game.phase==="discarded")return publicGame(game,now);
  if(action==="discard"){finishIncomplete(game,"discarded",now);return publicGame(game,now);}
  ensureChoices(game);
  if(expireGuess(game,now))return publicGame(game,now);
  if(round!==game.round)return publicGame(game,now);
  if(action==="fifty-fifty")useFiftyFifty(game);
  else if(action==="listen"&&game.phase==="ready"){game.phase="listening";game.listenAt=now;}
  else if(action==="heard"&&game.phase==="listening"){
    if(now-(game.listenAt??now)<CLIP_SECONDS*1000-250)throw new Error("Let the ten-second clip finish first.");game.phase="guessing";game.guessDeadline=now+GUESS_SECONDS*1000;
  }else if((action==="answer"||action==="pass")&&game.phase==="guessing"){
    const pick=game.picks[game.round];const chosen=visibleChoices(game)?.find(choice=>choice.id===input);
    if(action==="answer"&&!chosen)throw new Error("Choose one of the songs still shown for this round (four before 50/50).");
    game.results.push({round:game.round,title:pick.track.title,artist:pick.track.artist,artwork:pick.track.artwork,url:pick.track.url,tier:pick.tier,input:chosen?.label||"",correct:action==="answer"&&input===pick.correctChoiceId,skipped:action==="pass",...(isAssisted(game)?{assisted:true}:{})});game.phase="reveal";if(game.round===9)game.completedAt=now;
  }else if(action==="unavailable"&&["ready","listening"].includes(game.phase)){
    // A broken provider clip is never scored as a wrong answer. Keep the round retryable.
    game.phase="ready";game.listenAt=null;
  }else if(action==="next"&&game.phase==="reveal"){
    if(game.round===9){game.phase="complete";game.completedAt??=now;}else{game.round++;game.phase="ready";game.listenAt=null;game.guessDeadline=null;}
  }
  return publicGame(game,now);
}

export function unfinished(game:Game){return game.results.length<10&&game.phase!=="complete"&&game.phase!=="discarded";}
/** Reconcile an already elapsed guess, then finalize exactly once. Ten answers always complete a mix. */
export function finishIncomplete(game:Game,reason:IncompleteReason,now=Date.now()){
  if(game.phase==="discarded")return false;
  expireGuess(game,now);
  if(game.results.length===10||game.phase==="complete"){
    game.phase="complete";game.completionStatus="completed";game.completedAt??=now;delete game.incompleteReason;return false;
  }
  game.phase="discarded";game.completionStatus="incomplete";game.incompleteReason=reason;game.completedAt=now;game.listenAt=null;game.guessDeadline=null;return true;
}
