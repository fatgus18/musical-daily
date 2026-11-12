import {randomUUID} from "node:crypto";
import type {Catalog} from "../catalog.ts";
import {listThemes,listArtistThemes} from "../catalog.ts";
import {act,createGame,discardGame,publicGame,settleClock} from "../engine.ts";
import {BASE_POINTS,GUESS_DURATION_MS,MAX_LADDER} from "../rules.ts";
import {RoomError,type RoomActor,type RoomCommand,type RoomMember,type RoomSettings,type RoomState,type PublicRoom} from "./types.ts";

export const ROOM_LIMIT=8;
export const ROOM_PRESENCE_MS=45_000;
export const ROOM_REVEAL_MS=5_000;
export const ROOM_IDLE_MS=2*60*60*1000;
export const ROOM_RESULT_MS=24*60*60*1000;
const critical=new Set(["start","pick","bank","risk","guess","rematch"]);
function member(actor:RoomActor,now:number):RoomMember {
  const name=actor.name.normalize("NFKC").trim().replace(/\s+/g," ");
  if(!actor.id||!name||[...name].length>20||/[\p{Cc}\p{Cf}<>]/u.test(name))throw new RoomError("Choose a nickname of 1–20 characters.",400,"invalid_name");
  return {...actor,name,joinedAt:now,seenAt:now,ready:false,left:false};
}
export function requireMember(room:RoomState,id:string){const player=room.members.find(p=>p.id===id);if(!player)throw new RoomError("Join this room first.",401,"not_member");return player;}
function active(room:RoomState){return room.members.filter(p=>!p.left);}
function present(room:RoomState,now:number){return active(room).filter(p=>now-p.seenAt<=ROOM_PRESENCE_MS);}
function requireHost(room:RoomState,id:string){if(room.hostId!==id)throw new RoomError("Only the host can do that.",403,"host_only");}
function requireTurn(room:RoomState,id:string){if(room.activePlayerId!==id)throw new RoomError("It's your teammate's turn. Cheer them on!",403,"not_your_turn");}
function label(catalog:Catalog,theme:string){return listThemes(catalog).find(t=>t.id===theme)?.label??listArtistThemes(catalog).find(t=>t.id===theme)?.label??"Team collection";}
export function createRoomState(code:string,actor:RoomActor,catalog:Catalog,requestId:string,settings:RoomSettings={},now=Date.now()):RoomState {
  const game=createGame(`room:${code}`,catalog,requestId,{theme:settings.theme,metricFilter:settings.metricFilter},now);
  // The solo engine preselects the first pair. No timer or public exposure begins until the team commits.
  game.guessDeadline=null;
  return {code,matchId:randomUUID(),revision:0,createdBy:actor.id,requestId,hostId:actor.id,phase:"lobby",members:[member(actor,now)],activePlayerId:null,
    turn:0,game,themeLabel:label(catalog,game.theme),revealUntil:null,recentTurns:[],createdAt:now,updatedAt:now,expiresAt:now+ROOM_IDLE_MS,lastRematchRequestId:null,processed:[]};
}
export function joinRoomState(room:RoomState,actor:RoomActor,now=Date.now()){
  const previous=room.members.find(p=>p.id===actor.id);if(previous&&!previous.left){previous.seenAt=now;return;}
  if(room.phase!=="lobby")throw new RoomError("The team has started. Join the next run after a rematch.",409,"match_started");
  if(active(room).length>=ROOM_LIMIT)throw new RoomError("This room has eight players already.",409,"room_full");
  const next=member(actor,now);
  if(active(room).some(p=>p.name.toLocaleLowerCase()===next.name.toLocaleLowerCase()))throw new RoomError("That nickname is already in this room.",409,"name_taken");
  room.members=active(room);room.members.push(next);
  if(!room.members.some(p=>p.id===room.hostId))room.hostId=actor.id;
}
function nextPresent(room:RoomState,now:number,after:string|null){
  const start=room.members.findIndex(p=>p.id===after);
  for(let step=1;step<=room.members.length;step++){const p=room.members[(start+step+room.members.length)%room.members.length];if(!p.left&&now-p.seenAt<=ROOM_PRESENCE_MS)return p;}
  return undefined;
}
function finishRoom(room:RoomState,now:number,incomplete=false){
  if(incomplete)discardGame(room.game,"discarded",now);
  room.phase="complete";room.activePlayerId=null;room.revealUntil=null;room.expiresAt=now+(incomplete?ROOM_IDLE_MS:ROOM_RESULT_MS);
}
function captureReveal(room:RoomState,now:number,lostPot:number){
  const result=room.game.results.at(-1)!;const player=room.members.find(p=>p.id===room.activePlayerId)!;
  room.recentTurns=[...room.recentTurns,{...result,playerId:player.id,playerName:player.name,lostPot:result.correct?0:lostPot,turn:room.turn}].slice(-20);
  room.phase="reveal";room.revealUntil=now+ROOM_REVEAL_MS;
}
/** No catalog/network is needed for clock settlement, rotation, or reconnects. */
export function advanceRoom(room:RoomState,now=Date.now()):boolean {
  let changed=false;const host=room.members.find(p=>p.id===room.hostId&&!p.left);
  if(!host||now-host.seenAt>ROOM_PRESENCE_MS){const replacement=present(room,now).find(p=>p.id!==room.hostId);if(replacement){room.hostId=replacement.id;changed=true;}}
  if(room.phase!=="complete"&&!active(room).length){finishRoom(room,now,true);return true;}
  if(room.phase==="guess"){
    const pot=room.game.pot;if(settleClock(room.game,now)){captureReveal(room,now,pot);changed=true;}
  }
  if(room.phase==="reveal"&&room.revealUntil!==null&&now>=room.revealUntil){
    if(room.game.phase==="complete")finishRoom(room,now);
    else{room.turn++;const next=nextPresent(room,now,room.activePlayerId);room.activePlayerId=next?.id??null;room.phase=next?"decision":"paused";room.revealUntil=null;}
    changed=true;
  }
  if(room.phase==="decision"){
    const current=room.members.find(p=>p.id===room.activePlayerId&&!p.left);
    if(!current||now-current.seenAt>ROOM_PRESENCE_MS){const next=nextPresent(room,now,room.activePlayerId);room.turn++;room.activePlayerId=next?.id??null;room.phase=next?"decision":"paused";changed=true;}
  }
  if(room.phase==="paused"){
    const next=nextPresent(room,now,null);if(next){room.turn++;room.activePlayerId=next.id;room.phase="decision";changed=true;}
  }
  return changed;
}
export function applyRoomCommand(room:RoomState,id:string,command:RoomCommand,catalog?:Catalog,now=Date.now()){
  const player=requireMember(room,id);
  if(player.left&&command.action!=="leave")throw new RoomError("You left this team run.",403,"player_left");
  if(command.action==="rematch"&&command.requestId&&room.lastRematchRequestId===command.requestId){requireHost(room,id);return;}
  if(command.requestId){
    const prior=room.processed.find(p=>p.id===command.requestId&&p.playerId===id);
    if(prior){if(prior.matchId!==command.matchId||prior.turn!==command.turn||prior.action!==command.action)throw new RoomError("That request was already used for another move.",409,"request_conflict");return;}
  }
  if(command.matchId!==room.matchId||(!["heartbeat","leave"].includes(command.action)&&command.turn!==room.turn))throw new RoomError("The team has moved on. Refresh and try again.",409,"stale_turn");
  if(critical.has(command.action)&&(!command.requestId||command.requestId.length>128))throw new RoomError("A request ID is needed for this move.",400,"invalid_request");
  player.seenAt=now;
  if(command.action==="heartbeat"){advanceRoom(room,now);return;}
  if(command.action==="leave"){
    player.left=true;player.ready=false;
    if(room.hostId===id)room.hostId=active(room)[0]?.id??id;
    // A committed comparison stays timed even when its player leaves. No hard-pair escape.
    advanceRoom(room,now);return;
  }
  if(command.action==="ready"){
    if(room.phase!=="lobby")throw new RoomError("Ready up in the lobby.");player.ready=command.ready===true;return;
  }
  if(command.action==="start"){
    requireHost(room,id);if(room.phase!=="lobby")throw new RoomError("This run has already started.");
    const connected=present(room,now);if(connected.length<2||!connected.every(p=>p.ready))throw new RoomError("At least two connected teammates must be ready.",409,"not_ready");
    room.activePlayerId=connected[0].id;room.phase="decision";
  }else if(command.action==="rematch"){
    requireHost(room,id);if(room.phase!=="complete")throw new RoomError("Finish this team run before a rematch.");
    if(!catalog||catalog.version!==room.game.catalogVersion)throw new RoomError("The team's saved collection is unavailable. Retry shortly.",503,"catalog_unavailable");
    const game=createGame(`room:${room.code}`,catalog,command.requestId!,{theme:room.game.theme,metricFilter:room.game.metricFilter},now,{recentTracks:room.game.recentTracks,recentPairs:room.game.recentPairs});game.guessDeadline=null;
    room.game=game;room.matchId=randomUUID();room.turn=0;room.phase="lobby";room.members=active(room);for(const p of room.members)p.ready=false;
    room.activePlayerId=null;room.revealUntil=null;room.recentTurns=[];room.processed=[];room.lastRematchRequestId=command.requestId!;room.expiresAt=now+ROOM_IDLE_MS;
  }else if(command.action==="guess"){
    requireTurn(room,id);if(room.phase!=="guess")throw new RoomError("Start the next pick before answering.");
    if(command.choice!=="left"&&command.choice!=="right")throw new RoomError("Choose the left or right song.",400,"invalid_choice");
    const pot=room.game.pot;act(room.game,"guess",room.game.round,room.game.revision,command.choice,undefined,now);captureReveal(room,now,pot);
  }else if(["pick","bank","risk"].includes(command.action)){
    requireTurn(room,id);if(room.phase!=="decision")throw new RoomError("Wait for the team decision before the next pick.");
    if(!catalog||catalog.version!==room.game.catalogVersion)throw new RoomError("The team's saved collection is unavailable. Retry shortly.",503,"catalog_unavailable");
    if(command.action==="pick"){
      if(room.game.pot!==0)throw new RoomError("Choose whether to bank or risk the team's pot first.");
      if(room.game.answered===0){room.game.guessDeadline=now+GUESS_DURATION_MS;room.game.phase="guess";room.game.updatedAt=now;room.game.revision++;}
      else act(room.game,"next",room.game.round,room.game.revision,undefined,catalog,now);
    }else{
      if(room.game.pot<=0)throw new RoomError("There are no team points to bank or risk yet.");
      if(command.action==="risk"&&room.game.ladder>=MAX_LADDER)throw new RoomError("Bank this completed ladder before continuing.");
      act(room.game,command.action as "bank"|"risk",room.game.round,room.game.revision,undefined,catalog,now);
    }
    if(room.game.phase==="complete")finishRoom(room,now);else room.phase="guess";
  }else throw new RoomError("Unknown room action.",400,"invalid_action");
  room.processed=[...room.processed,{id:command.requestId!,playerId:id,matchId:command.matchId,turn:command.turn,action:command.action}].slice(-128);
}
export function projectRoom(room:RoomState,id:string,now=Date.now()):PublicRoom {
  const player=requireMember(room,id);const game=room.game;
  const team={banked:game.banked,pot:game.pot,lives:game.lives,answered:game.answered,correct:game.correct,bestStreak:game.bestStreak,currentStreak:game.currentStreak,
    ladder:game.ladder,canRisk:game.pot>0&&game.ladder<MAX_LADDER,nextReward:game.ladder<MAX_LADDER?BASE_POINTS*2**game.ladder:0,maxLadder:MAX_LADDER};
  let pair:PublicRoom["pair"];
  if(room.phase==="guess"||room.phase==="reveal"){
    const source=publicGame(game,now).pair;
    const clean=(track:typeof source.left)=>({id:track.id,title:track.title,artist:track.artist,artwork:track.artwork});
    pair={...source,left:clean(source.left),right:clean(source.right)};
  }
  return {code:room.code,matchId:room.matchId,revision:room.revision,phase:room.phase,hostId:room.hostId,youId:id,
    players:room.members.map(p=>({id:p.id,name:p.name,avatar:p.avatar,ready:p.ready,left:p.left,present:!p.left&&now-p.seenAt<=ROOM_PRESENCE_MS})),
    activePlayerId:room.activePlayerId,turn:room.turn,serverNow:now,guessDeadline:room.phase==="guess"?game.guessDeadline??null:null,revealUntil:room.revealUntil,
    catalogVersion:game.catalogVersion,theme:game.theme,themeLabel:room.themeLabel,metricFilter:game.metricFilter,team,
    ...(pair?{pair}:{}),...(room.phase==="reveal"?{reveal:room.recentTurns.at(-1)}:{}),recentTurns:room.recentTurns,you:{ready:player.ready,left:player.left},
    ...(room.phase==="complete"?{completionStatus:game.completionStatus??"completed",endReason:game.endReason}:{})};
}
