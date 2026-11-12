import {randomUUID} from "node:crypto";
import type {ArtistPool} from "../catalog.ts";
import {createGame} from "../engine.ts";
import {catalogOffer, trackIdentity} from "../rules.ts";
import {RoomError, type RoomActor, type RoomCommand, type RoomMember, type RoomState, type PublicRoom, type RoomStanding, type RoomArtistMode} from "./types.ts";

export const ROOM_LIMIT=8;
export const ROOM_CLIP_MS=15_000;
export const ROOM_GUESS_MS=15_000;
export const ROOM_LOADING_MS=35_000;
export const ROOM_REVEAL_MS=5_000;
export const ROOM_COUNTDOWN_MS=4_000;
export const ROOM_HOST_STALE_MS=45_000;
export const ROOM_IDLE_MS=2*60*60*1000;
export const ROOM_RESULT_MS=24*60*60*1000;

function member(actor:RoomActor,now:number):RoomMember {
  const name=actor.name.trim().replace(/[\u0000-\u001f\u007f]/g,"").slice(0,32);
  if(!actor.id||!name)throw new RoomError("Choose a name for the room.",400,"invalid_name");
  return {...actor,name,joinedAt:now,seenAt:now,ready:false,loaded:false,left:false,guessAt:null,answer:null};
}
export function requireMember(room:RoomState,id:string) {
  const player=room.members.find(p=>p.id===id);
  if(!player)throw new RoomError("Join this room before opening it.",401,"not_member");
  return player;
}
function active(room:RoomState) {return room.members.filter(p=>!p.left);}
function present(room:RoomState,now:number) {return active(room).filter(p=>now-p.seenAt<=ROOM_HOST_STALE_MS);}
function requireHost(room:RoomState,id:string) {
  if(room.hostId!==id)throw new RoomError("Only the room host can do that.",403,"host_only");
}
function select(room:RoomState,pool:ArtistPool,requestId:string,now:number) {
  const offer=catalogOffer(pool);
  if(!offer.discoveryAvailable&&!offer.rankedAvailable)throw new RoomError("This artist needs ten playable songs. Try another artist.",422,"insufficient_songs");
  const game=createGame(`room:${room.code}`,pool,room.artist.id===pool.artist.id?room.history:[],requestId,now,offer.rankedAvailable?"ranked":"discovery");
  if(game.picks.length!==10)throw new RoomError("This artist needs ten playable songs.",422,"insufficient_songs");
  if(room.artist.id!==pool.artist.id)room.history=[];
  room.artist=game.artist; room.ranking=game.ranking; room.picks=game.picks;
}
export function createRoomState(code:string,actor:RoomActor,pool:ArtistPool,requestId:string,now=Date.now(),artistMode:RoomArtistMode="chosen"):RoomState {
  const room:RoomState={code,matchId:randomUUID(),revision:0,hostId:actor.id,createdBy:actor.id,requestId,
    artist:pool.artist,artistMode,ranking:pool.ranking,phase:"lobby",members:[member(actor,now)],picks:[],history:[],round:0,
    createdAt:now,updatedAt:now,expiresAt:now+ROOM_IDLE_MS,startAt:null,roundEnd:null,loadingDeadline:null,
    revealUntil:null,reveals:[],lastRematchRequestId:null,audioRevision:0};
  select(room,pool,requestId,now); return room;
}
export function joinRoomState(room:RoomState,actor:RoomActor,now=Date.now()) {
  const existing=room.members.find(p=>p.id===actor.id);
  if(existing&&!existing.left){existing.seenAt=now;return;}
  if(room.phase!=="lobby")throw new RoomError("This match has started. Ask the host for a rematch to join the next one.",409,"match_started");
  if(active(room).length>=ROOM_LIMIT)throw new RoomError("This room is full (eight players).",409,"room_full");
  if(active(room).some(p=>p.name.normalize("NFKC").toLocaleLowerCase()===actor.name.trim().normalize("NFKC").toLocaleLowerCase()))throw new RoomError("Someone in this room already uses that name. Pick another nickname.",409,"name_taken");
  // Lobby leavers have no scored history; removing them keeps room state bounded.
  room.members=room.members.filter(p=>!p.left);
  room.members.push(member(actor,now));
  if(!room.members.some(p=>p.id===room.hostId))room.hostId=actor.id;
}
function beginLoading(room:RoomState,now:number) {
  room.phase="loading";room.startAt=null;room.roundEnd=null;room.loadingDeadline=now+ROOM_LOADING_MS;room.revealUntil=null;
  for(const player of room.members){player.loaded=false;player.guessAt=null;player.answer=null;}
}
function guessAt(room:RoomState,player:RoomMember,now:number) {
  if(room.startAt===null||now<room.startAt)return null;
  return player.guessAt??(now>=room.startAt+ROOM_CLIP_MS?room.startAt+ROOM_CLIP_MS:null);
}
function guessDeadline(room:RoomState,player:RoomMember,now:number) {
  const at=guessAt(room,player,now); return at===null||room.roundEnd===null?null:Math.min(room.roundEnd,at+ROOM_GUESS_MS);
}
function closeRound(room:RoomState,now:number,reason:"preview_unavailable"|"host_skipped"|null=null) {
  if(room.reveals.some(r=>r.round===room.round))return;
  const pick=room.picks[room.round];
  room.reveals.push({round:room.round,title:pick.track.title,artist:pick.track.artist,artwork:pick.track.artwork,url:pick.track.url,
    correctChoiceId:pick.correctChoiceId!,choices:pick.choices!.map(c=>({...c})),voided:reason!==null,reason,
    answers:room.members.map(p=>({playerId:p.id,choiceId:reason?null:p.answer?.choiceId??null,correct:reason?false:p.answer?.correct??false,
      elapsedMs:reason?0:p.answer?.elapsedMs??ROOM_CLIP_MS+ROOM_GUESS_MS,timedOut:reason?false:p.answer?.timedOut??true}))});
  room.phase="reveal";room.revealUntil=now+ROOM_REVEAL_MS;room.loadingDeadline=null;
}
/** Reconcile clocks without trusting a client timer. Returns whether durable state changed. */
export function advanceRoom(room:RoomState,now=Date.now()):boolean {
  let changed=false;
  const host=room.members.find(p=>p.id===room.hostId&&!p.left);
  if(!host||(["lobby","loading","complete"].includes(room.phase)&&now-host.seenAt>ROOM_HOST_STALE_MS)){
    const replacement=active(room).find(p=>p.id!==room.hostId&&now-p.seenAt<=ROOM_HOST_STALE_MS);
    if(replacement){room.hostId=replacement.id;changed=true;}
  }
  if(room.phase==="loading"){
    if(room.loadingDeadline!==null&&now>=room.loadingDeadline){closeRound(room,now,"preview_unavailable");changed=true;}
    else if(present(room,now).length&&present(room,now).every(p=>p.loaded)){
      room.phase="playing";room.startAt=now+ROOM_COUNTDOWN_MS;room.roundEnd=room.startAt+ROOM_CLIP_MS+ROOM_GUESS_MS;room.loadingDeadline=null;changed=true;
    }
  }
  if(room.phase==="playing"&&room.startAt!==null&&now>=room.startAt){
    for(const player of active(room)){
      const deadline=guessDeadline(room,player,now);
      if(!player.answer&&deadline!==null&&now>=deadline){
        player.answer={choiceId:null,correct:false,elapsedMs:Math.max(0,deadline-room.startAt),answeredAt:deadline,timedOut:true};changed=true;
      }
    }
    if(active(room).every(p=>p.answer!==null)){closeRound(room,now);changed=true;}
  }
  if(room.phase==="reveal"&&room.revealUntil!==null&&now>=room.revealUntil){
    if(room.round===9||!active(room).length){room.phase="complete";room.expiresAt=now+(active(room).length?ROOM_RESULT_MS:ROOM_IDLE_MS);room.revealUntil=null;}
    else{room.round++;beginLoading(room,now);}
    changed=true;
  }
  return changed;
}
export function applyRoomCommand(room:RoomState,id:string,command:RoomCommand,pool?:ArtistPool,now=Date.now()) {
  const player=requireMember(room,id);
  // A retried rematch request must not create a second match even with the old match ID.
  if(command.action==="rematch"&&command.requestId&&command.requestId===room.lastRematchRequestId){requireHost(room,id);return;}
  if(command.matchId!==room.matchId||command.round!==room.round)throw new RoomError("The room has moved on. Refreshing your match…",409,"stale_round");
  if(command.action==="leave"){
    player.left=true;player.ready=false;player.loaded=false;
    if(room.hostId===id)room.hostId=active(room)[0]?.id??id;
    advanceRoom(room,now);return;
  }
  if(player.left)throw new RoomError("You left this match. Join again when the room is in the lobby.",403,"player_left");
  player.seenAt=now;
  if(command.action==="heartbeat")return;
  if(command.action==="ready"){
    if(room.phase!=="lobby")throw new RoomError("Ready up in the lobby.");
    player.ready=command.ready===true;return;
  }
  if(command.action==="start"){
    requireHost(room,id);
    if(room.phase!=="lobby")return;
    const connected=present(room,now);
    if(connected.length<2||!connected.every(p=>p.ready))throw new RoomError("At least two players must be connected, and every connected player must be ready.",409,"not_ready");
    const history=new Map(room.history.map(h=>[h.id,h]));
    for(const pick of room.picks){const key=trackIdentity(pick.track);const previous=history.get(key);history.set(key,{id:key,plays:(previous?.plays??0)+1,lastPlayed:now});}
    room.history=[...history.values()].sort((a,b)=>b.lastPlayed-a.lastPlayed).slice(0,500);
    beginLoading(room,now);return;
  }
  if(command.action==="configure"||command.action==="rematch"){
    requireHost(room,id);
    if(command.action==="configure"&&room.phase!=="lobby")throw new RoomError("Choose an artist before the match starts.");
    if(command.action==="rematch"&&room.phase!=="complete")throw new RoomError("Finish this match before starting a rematch.");
    if(!pool)throw new RoomError("Load the artist's songs before starting this match.",400,"missing_catalog");
    if(!command.requestId)throw new RoomError("A request ID is required.",400,"invalid_request");
    select(room,pool,command.requestId,now);
    if(command.action==="configure")room.artistMode=command.artistMode??"chosen";
    room.matchId=randomUUID();room.phase="lobby";room.round=0;room.reveals=[];room.startAt=null;room.roundEnd=null;room.loadingDeadline=null;room.revealUntil=null;
    room.audioRevision++;room.members=active(room);
    for(const p of room.members){p.ready=false;p.loaded=false;p.guessAt=null;p.answer=null;}
    if(command.action==="rematch")room.lastRematchRequestId=command.requestId;
    room.expiresAt=now+ROOM_IDLE_MS;return;
  }
  if(command.action==="retry"||command.action==="skip"){
    requireHost(room,id);
    if(room.phase!=="loading")throw new RoomError("Only a clip that has not started can be retried or skipped.");
    if(command.action==="retry"){room.audioRevision++;beginLoading(room,now);}
    else closeRound(room,now,"host_skipped");
    return;
  }
  if(command.action==="loaded"){
    if(command.audioRevision!==room.audioRevision)throw new RoomError("That audio was replaced. Load the current clip first.",409,"stale_audio");
    if(room.phase==="playing"&&player.loaded)return;
    if(room.phase!=="loading")throw new RoomError("This clip is no longer loading.");
    player.loaded=true;advanceRoom(room,now);return;
  }
  if(player.answer&&["answer","pass","guess"].includes(command.action)&&["reveal","complete"].includes(room.phase))return;
  if(room.phase!=="playing"||room.startAt===null||now<room.startAt)throw new RoomError("Wait for the round to start.",409,"round_not_playing");
  if(player.answer)return;
  if(command.action==="guess"){
    player.guessAt??=Math.min(now,room.startAt+ROOM_CLIP_MS);return;
  }
  if(command.action==="answer"||command.action==="pass"){
    const opened=guessAt(room,player,now);
    if(opened===null)throw new RoomError("Tap ‘I know it’ to open the answers first.",409,"guess_not_open");
    const deadline=guessDeadline(room,player,now)!;
    if(now>=deadline){advanceRoom(room,now);return;}
    const pick=room.picks[room.round];
    if(command.action==="answer"&&!pick.choices?.some(c=>c.id===command.choiceId))throw new RoomError("Choose one of the four answers for this round.",400,"invalid_choice");
    player.guessAt=opened;
    player.answer={choiceId:command.action==="answer"?command.choiceId!:null,correct:command.action==="answer"&&command.choiceId===pick.correctChoiceId,
      elapsedMs:Math.floor(Math.max(0,now-room.startAt)/100)*100,answeredAt:now,timedOut:false};
    advanceRoom(room,now);return;
  }
  throw new RoomError("Unknown room action.",400,"invalid_action");
}
export function roomStandings(room:RoomState):RoomStanding[] {
  const standings=room.members.map(player=>{
    const correct=room.reveals.filter(r=>!r.voided).flatMap(r=>r.answers).filter(a=>a.playerId===player.id&&a.correct);
    return {id:player.id,name:player.name,avatar:player.avatar,score:correct.length*1000,correct:correct.length,timeMs:correct.reduce((sum,a)=>sum+a.elapsedMs,0),rank:0,left:player.left,winner:false};
  }).sort((a,b)=>b.correct-a.correct||a.timeMs-b.timeMs||a.id.localeCompare(b.id));
  standings.forEach((p,index)=>{const previous=standings[index-1];p.rank=previous&&p.correct===previous.correct&&p.timeMs===previous.timeMs?previous.rank:index+1;});
  // Leaving forfeits winning; temporary disconnections preserve earned points.
  const eligible=standings.filter(p=>!p.left);const best=eligible[0];
  for(const p of eligible)p.winner=room.phase==="complete"&&!!best&&best.correct>0&&p.correct===best.correct&&p.timeMs===best.timeMs;
  return standings;
}
export function projectRoom(room:RoomState,id:string,now=Date.now()):PublicRoom {
  const player=requireMember(room,id);const at=room.phase==="playing"?guessAt(room,player,now):player.guessAt;
  return {code:room.code,matchId:room.matchId,revision:room.revision,phase:room.phase,artist:room.artist,artistMode:room.artistMode??"chosen",hostId:room.hostId,youId:id,
    players:room.members.map(p=>({id:p.id,name:p.name,avatar:p.avatar,ready:p.ready,loaded:p.loaded,answered:p.answer!==null,left:p.left,present:!p.left&&now-p.seenAt<=ROOM_HOST_STALE_MS})),
    round:room.round,totalRounds:10,serverNow:now,startAt:room.startAt,roundEnd:room.roundEnd,loadingDeadline:room.loadingDeadline,revealUntil:room.revealUntil,
    clipSeconds:15,clipOffset:8,guessSeconds:15,audioRevision:room.audioRevision,
    ...(room.phase==="playing"&&at!==null&&!player.left?{choices:room.picks[room.round].choices!.map(c=>({...c}))}:{}),
    you:{ready:player.ready,loaded:player.loaded,guessAt:at,guessDeadline:room.phase==="playing"?guessDeadline(room,player,now):null,
      answered:player.answer!==null,choiceId:player.answer?.choiceId??null,passed:!!player.answer&&!player.answer.choiceId&&!player.answer.timedOut,left:player.left},
    reveals:room.reveals,leaderboard:roomStandings(room)};
}
