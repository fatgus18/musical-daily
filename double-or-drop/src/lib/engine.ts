import {randomUUID} from "node:crypto";
import {filterCatalog} from "./catalog.ts";
import type {Catalog,CatalogTrack} from "./catalog.ts";
import type {Game,Move,MetricFilter,PublicGame,RoundResult,RunHistory,Side,ValueReveal} from "./types.ts";
import {BASE_POINTS,GUESS_DURATION_MS,INITIAL_LIVES,MAX_BANKED_POINTS,MAX_COMPARISONS,MAX_LADDER,METRICS,METRIC_LABELS,availableMetrics,displayValue,drawPair,pairKey,winner} from "./rules.ts";
import {validBankTarget,type BankTarget} from "./run-goals.ts";

export interface RunSettings {theme?:string;metricFilter?:MetricFilter;bankTarget?:BankTarget|null;bestBankToBeat?:number|null}
export function createGame(player:string,catalog:Catalog,requestId:string,settings:RunSettings={},now=Date.now(),history:RunHistory={recentTracks:[],recentPairs:[]}):Game{
  const theme=settings.theme||"all",metricFilter=settings.metricFilter||"mixed";
  if(!validBankTarget(settings.bankTarget))throw new Error("Choose one of the available bank targets.");
  if(settings.bestBankToBeat!=null&&(!Number.isSafeInteger(settings.bestBankToBeat)||settings.bestBankToBeat<=0||settings.bestBankToBeat>MAX_BANKED_POINTS))throw new Error("The saved personal best is invalid.");
  if(!theme||theme.length>150||!(metricFilter==="mixed"||METRICS.includes(metricFilter)))throw new Error("Choose a valid collection and comparison type.");
  const tracks=filterCatalog(catalog,theme);
  if(tracks.length<2||!availableMetrics(tracks,metricFilter).length)throw new Error("This collection needs more comparable songs. Choose another collection.");
  const id=randomUUID();
  const recentTracks=history.recentTracks.slice(-40),recentPairs=history.recentPairs.slice(-40);
  const pair=drawPair(tracks,{seed:`${id}:0`,filter:metricFilter,round:0,ladder:0,recentPairs,recentTracks});
  return {id,player,requestId,revision:0,catalogVersion:catalog.version,phase:"guess",round:0,lives:INITIAL_LIVES,banked:0,pot:0,ladder:0,correct:0,answered:0,currentStreak:0,bestStreak:0,theme,metricFilter,pair,results:[],recentTracks:[...recentTracks,pair.left.id,pair.right.id].slice(-40),recentPairs:[...recentPairs,pairKey(pair)].slice(-40),createdAt:now,updatedAt:now,guessDeadline:now+GUESS_DURATION_MS,completedAt:null,bankTarget:settings.bankTarget??null,bestBankToBeat:settings.bestBankToBeat??null};
}
function revealValue(game:Game,side:Side):ValueReveal{const data=game.pair[side].metrics[game.pair.metric]!;return {value:data.value,formatted:displayValue(game.pair.metric,data.value),source:data.sourceUrl,...(data.asOf?{asOf:data.asOf}:{}),...(data.quality?{quality:data.quality}:{})};}
function nextPair(game:Game,catalog:Catalog,now:number){
  if(catalog.version!==game.catalogVersion)throw new Error("This run's collection is temporarily unavailable. Please retry.");
  const round=game.round+1;
  const pair=drawPair(filterCatalog(catalog,game.theme),{seed:`${game.id}:${round}`,filter:game.metricFilter,round,ladder:game.ladder,recentPairs:game.recentPairs,recentTracks:game.recentTracks,previousMetric:game.pair.metric});
  game.round=round;game.pair=pair;game.phase="guess";game.guessDeadline=now+GUESS_DURATION_MS;
  game.recentTracks=[...game.recentTracks,pair.left.id,pair.right.id].slice(-40);
  game.recentPairs=[...game.recentPairs,pairKey(pair)].slice(-40);
}
function bankPot(game:Game){game.banked=Math.min(MAX_BANKED_POINTS,game.banked+game.pot);game.pot=0;game.ladder=0;}
function finish(game:Game,reason:Game["endReason"],now:number){game.phase="complete";game.completionStatus="completed";game.completedAt=now;game.endReason=reason;game.guessDeadline=null;}
/** Terminal discard keeps only protected points. The caller settles the clock first and
 * increments the revision in the same transaction that writes the account outbox. */
export function discardGame(game:Game,reason:"discarded"|"expired"|"account-merge",now:number){
  if(game.phase==="complete")return;
  game.pot=0;game.ladder=0;finish(game,reason,now);game.completionStatus="incomplete";
}
function resolvePick(game:Game,choice:Side|null,now:number){
  const timedOut=choice===null,winning=winner(game.pair),correct=!timedOut&&choice===winning;
  game.guessDeadline=null;game.answered++;
  if(correct){game.correct++;game.currentStreak++;game.bestStreak=Math.max(game.bestStreak,game.currentStreak);game.ladder++;game.pot=BASE_POINTS*2**(game.ladder-1);game.phase="decision";}
  else {game.lives--;game.pot=0;game.ladder=0;game.currentStreak=0;game.phase="miss";if(game.lives===0)finish(game,"lives",now);}
  const left=revealValue(game,"left"),right=revealValue(game,"right"),lead=game.pair[winning].title;
  const explanation=game.pair.metric==="year"?`${lead} was released earlier.`:game.pair.metric==="streams"?`${lead} has the larger observed stream count. Counts are dated snapshots, not live totals.`:game.pair.metric==="tempo"?`${lead} has the faster measured tempo. Tempo estimates can follow half-time or double-time beats.`:`${lead} is the longer recording. These lengths refer to the versions shown.`;
  const result:RoundResult={round:game.round,metric:game.pair.metric,selected:choice,winner:winning,correct,timedOut,left,right,leftTitle:game.pair.left.title,rightTitle:game.pair.right.title,explanation:timedOut?`Time ran out. ${explanation}`:explanation,earned:correct?game.pot:0};
  game.results=[...game.results,result].slice(-20);
  if(game.answered>=MAX_COMPARISONS&&game.lives>0){bankPot(game);finish(game,"run-limit",now);}
}
/** Called inside a write transaction before reads and moves. Each elapsed pick settles once.
 * Legacy untimed picks receive one fresh window; its persisted revision prevents reset on reload. */
export function settleClock(game:Game,now=Date.now()):boolean{
  if(game.phase!=="guess")return false;
  if(typeof game.guessDeadline!=="number"||!Number.isFinite(game.guessDeadline)){
    game.guessDeadline=now+GUESS_DURATION_MS;game.revision++;game.updatedAt=now;return true;
  }
  if(now<game.guessDeadline)return false;
  // Use the actual expiry instant for the completed result, even if the browser was closed.
  resolvePick(game,null,game.guessDeadline);game.revision++;game.updatedAt=now;return true;
}
/** Retiring a comparison must never take a life or erase earned points. A pending
 * question is replaced before its deadline can settle, and the revision makes any
 * answer from an older tab stale. Answered questions remain available as history. */
export function migrateRetiredMetric(game:Game,catalog:Catalog,currentCatalog:()=>Catalog,now=Date.now()):boolean{
  if(game.phase==="complete"||(game.metricFilter!=="tempo"&&!(game.phase==="guess"&&game.pair.metric==="tempo")))return false;
  if(catalog.version!==game.catalogVersion)throw new Error("This run's collection is temporarily unavailable. Please retry.");
  const draft=structuredClone(game);
  if(draft.metricFilter==="tempo")draft.metricFilter="mixed";
  let selected=catalog;
  let tracks=filterCatalog(selected,draft.theme);
  if(!availableMetrics(tracks,draft.metricFilter).length){
    selected=currentCatalog();tracks=filterCatalog(selected,draft.theme);
    if(!availableMetrics(tracks,draft.metricFilter).length){draft.theme="all";tracks=filterCatalog(selected,"all");}
  }
  if(!availableMetrics(tracks,draft.metricFilter).length)throw new Error("No fair replacement comparison is available. Your saved points are protected.");
  draft.catalogVersion=selected.version;
  if(draft.phase==="guess"&&draft.pair.metric==="tempo"){
    const pair=drawPair(tracks,{seed:`${draft.id}:${draft.round}:tempo-retired`,filter:draft.metricFilter,round:draft.round,ladder:draft.ladder,recentPairs:draft.recentPairs,recentTracks:draft.recentTracks});
    draft.pair=pair;draft.guessDeadline=now+GUESS_DURATION_MS;
    draft.recentTracks=[...draft.recentTracks,pair.left.id,pair.right.id].slice(-40);
    draft.recentPairs=[...draft.recentPairs,pairKey(pair)].slice(-40);
  }
  draft.modeNotice="Tempo comparisons have retired because not every song has a preview. Your points and lives are unchanged."+(draft.theme!==game.theme?" This run now uses the full collection.":"");
  draft.revision++;draft.updatedAt=now;Object.assign(game,draft);return true;
}
/** All transitions run inside the store's transaction. A revision can be consumed once. */
export function act(game:Game,action:Move,expectedRound:number,expectedRevision:number,choice:Side|undefined,catalog:Catalog|undefined,now=Date.now()):{game:PublicGame;stale:boolean}{
  const draft=structuredClone(game);
  if(settleClock(draft,now)){Object.assign(game,draft);return {game:publicGame(game,now),stale:true};}
  const result=applyMove(draft,action,expectedRound,expectedRevision,choice,catalog,now);
  if(!result.stale)Object.assign(game,draft);
  return result;
}
function applyMove(game:Game,action:Move,expectedRound:number,expectedRevision:number,choice:Side|undefined,catalog:Catalog|undefined,now:number):{game:PublicGame;stale:boolean}{
  if(game.round!==expectedRound||game.revision!==expectedRevision)return {game:publicGame(game,now),stale:true};
  if(game.phase==="complete")return {game:publicGame(game,now),stale:true};
  // A fast client clock cannot shorten the authoritative window or consume a revision.
  if(action==="timeout")return {game:publicGame(game,now),stale:true};
  if(action==="guess"){
    if(game.phase!=="guess"||(choice!=="left"&&choice!=="right"))throw new Error("Choose the song on the left or right.");
    resolvePick(game,choice,now);
  }else if(action==="discard"){
    discardGame(game,"discarded",now);
  }else if(action==="cashout"){
    // A risk decision is binding: seeing the next pair never unlocks a late cashout.
    if(game.phase==="guess"&&game.pot>0)throw new Error("Finish this comparison before cashing out. Your banked points are protected.");
    if(game.answered===0)discardGame(game,"discarded",now);
    else {bankPot(game);finish(game,"cashout",now);}
  }else if(action==="bank"){
    if(game.phase!=="decision"||!game.pot)throw new Error("Win a comparison before banking points.");
    if(!catalog)throw new Error("The next comparison couldn't load. Your points are safe; please retry.");
    bankPot(game);if(game.banked>=MAX_BANKED_POINTS)finish(game,"score-limit",now);else nextPair(game,catalog,now);
  }else if(action==="risk"){
    if(game.phase!=="decision"||game.ladder>=MAX_LADDER)throw new Error("Bank this ladder before continuing.");
    if(!catalog)throw new Error("The next comparison couldn't load. Your points are safe; please retry.");
    nextPair(game,catalog,now);
  }else if(action==="next"){
    if(game.phase!=="miss")throw new Error("Finish this comparison first.");
    if(!catalog)throw new Error("The next comparison couldn't load. Please retry.");
    nextPair(game,catalog,now);
  }else throw new Error("Unknown game action.");
  game.revision++;game.updatedAt=now;
  return {game:publicGame(game,now),stale:false};
}
const publicTrack=(track:CatalogTrack,tempo:boolean,revealed:boolean)=>({id:track.id,title:track.title,artist:track.artist,artwork:track.artwork,...(tempo&&track.previewUrl?{previewUrl:track.previewUrl}:{}),...(tempo&&revealed&&track.previewSourceUrl?{previewSourceUrl:track.previewSourceUrl}:{})});
export function publicGame(game:Game,now=Date.now()):PublicGame{
  const labels=METRIC_LABELS[game.pair.metric];
  return {bankTarget:game.bankTarget??null,bestBankToBeat:game.bestBankToBeat??null,id:game.id,revision:game.revision,phase:game.phase,round:game.round,lives:game.lives,banked:game.banked,pot:game.pot,ladder:game.ladder,correct:game.correct,answered:game.answered,currentStreak:game.currentStreak,bestStreak:game.bestStreak,theme:game.theme,metricFilter:game.metricFilter,canRisk:game.phase==="decision"&&game.ladder<MAX_LADDER,nextReward:game.ladder<MAX_LADDER?BASE_POINTS*2**game.ladder:0,maxLadder:MAX_LADDER,pair:{left:publicTrack(game.pair.left,game.pair.metric==="tempo",game.phase!=="guess"),right:publicTrack(game.pair.right,game.pair.metric==="tempo",game.phase!=="guess"),metric:game.pair.metric,...labels},...(game.phase!=="guess"&&game.results.at(-1)?.round===game.round?{reveal:game.results.at(-1)}:{}),results:game.results,guessDeadline:game.phase==="guess"?game.guessDeadline??null:null,serverNow:now,createdAt:game.createdAt,completedAt:game.completedAt,endReason:game.endReason,completionStatus:game.phase==="complete"?game.completionStatus??"completed":null,catalogVersion:game.catalogVersion,...(game.modeNotice?{modeNotice:game.modeNotice}:{})};
}
