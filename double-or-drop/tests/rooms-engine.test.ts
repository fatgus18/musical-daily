import test from "node:test";
import assert from "node:assert/strict";
import type {Catalog,CatalogTrack} from "../src/lib/catalog.ts";
import {winner,MAX_COMPARISONS,MAX_BANKED_POINTS} from "../src/lib/rules.ts";
import {advanceRoom,applyRoomCommand,createRoomState,joinRoomState,projectRoom} from "../src/lib/rooms/engine.ts";
import type {RoomAction,RoomCommand,RoomState} from "../src/lib/rooms/types.ts";

const tracks:CatalogTrack[]=Array.from({length:40},(_,i)=>({id:`track-${i}`,title:`Private Song ${i}`,artist:`Artist ${i%4}`,artwork:"https://example.com/art.jpg",sourceUrl:"https://example.com/catalog",genre:"pop",metrics:{duration:{value:100+i*5,sourceUrl:"https://example.com/duration"},streams:{value:100000*(i+1),sourceUrl:"https://example.com/streams",asOf:"2026-11-12"}},previewUrl:"https://audio-ssl.itunes.apple.com/private.m4a",previewSourceUrl:"https://music.apple.com"}));
const catalog:Catalog={schema:1,version:"0123456789abcdef",createdAt:"2026-11-12T00:00:00.000Z",tracks,sources:[{id:"fixture",url:"https://example.com",note:"Fixture only"}]};
let sequence=0;
const command=(r:RoomState,action:RoomAction,extra:Partial<RoomCommand>={}):RoomCommand=>({action,matchId:r.matchId,turn:r.turn,requestId:`move-${++sequence}`,...extra});
function lobby(){const room=createRoomState("ABC234",{id:"a",name:"Alice"},catalog,"create",{},1000);joinRoomState(room,{id:"b",name:"Bob"},1000);return room;}
function decision(){const room=lobby();for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"ready",{ready:true}),undefined,2000);applyRoomCommand(room,"a",command(room,"start"),undefined,3000);return room;}
function choose(room:RoomState,now:number){applyRoomCommand(room,room.activePlayerId!,command(room,room.game.pot?"risk":"pick"),catalog,now);}
function answer(room:RoomState,correct:boolean,now:number){const win=winner(room.game.pair);applyRoomCommand(room,room.activePlayerId!,command(room,"guess",{choice:correct?win:win==="left"?"right":"left"}),undefined,now);}
test("lobby and decisions hide every future pair; guessing reveals no values, source URLs, or audio",()=>{
  const room=decision();for(const id of ["a","b"]){const view=projectRoom(room,id,3000);assert.equal(view.pair,undefined);assert.equal(view.guessDeadline,null);assert.equal(JSON.stringify(view).includes("Private Song"),false);}
  choose(room,4000);const view=projectRoom(room,"b",4000);assert.equal(view.phase,"guess");assert.equal(view.guessDeadline,24000);assert.ok(view.pair?.left.title);const pair=JSON.stringify(view.pair);assert.equal(pair.includes('"value"'),false);assert.equal(pair.includes("preview"),false);assert.equal(pair.includes("sourceUrl"),false);
  assert.throws(()=>projectRoom(room,"unknown",4000),{code:"not_member"});
});
test("only the active teammate may commit or answer, with immutable decisions and duplicate scoring protection",()=>{
  const room=decision();assert.throws(()=>applyRoomCommand(room,"b",command(room,"pick"),catalog,4000),{code:"not_your_turn"});
  const pick=command(room,"pick");applyRoomCommand(room,"a",pick,catalog,4000);const deadline=room.game.guessDeadline;applyRoomCommand(room,"a",pick,catalog,9000);assert.equal(room.game.guessDeadline,deadline);
  assert.throws(()=>applyRoomCommand(room,"b",command(room,"guess",{choice:winner(room.game.pair)}),undefined,5000),{code:"not_your_turn"});
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"bank"),catalog,5000),{code:"room_conflict"});
  const guess=command(room,"guess",{choice:winner(room.game.pair)});applyRoomCommand(room,"a",guess,undefined,6000);applyRoomCommand(room,"a",guess,undefined,6100);assert.equal(room.game.correct,1);assert.equal(room.game.pot,100);assert.equal(room.recentTurns.length,1);
  assert.throws(()=>applyRoomCommand(room,"a",{...guess,action:"risk"},catalog,6200),{code:"request_conflict"});
});
test("answers reveal together for five seconds then rotate, and banking happens before any new pair is shown",()=>{
  const room=decision();choose(room,4000);answer(room,true,5000);assert.equal(room.phase,"reveal");assert.equal(room.activePlayerId,"a");assert.equal(projectRoom(room,"b",5000).reveal?.playerId,"a");
  advanceRoom(room,9999);assert.equal(room.phase,"reveal");advanceRoom(room,10000);assert.equal(room.phase,"decision");assert.equal(room.activePlayerId,"b");assert.equal(projectRoom(room,"a",10000).pair,undefined);
  applyRoomCommand(room,"b",command(room,"bank"),catalog,11000);assert.equal(room.game.banked,100);assert.equal(room.game.pot,0);assert.equal(room.game.ladder,0);assert.equal(room.phase,"guess");assert.equal(room.game.guessDeadline,31000);
  answer(room,true,12000);assert.equal(room.game.pot,100);assert.equal(room.game.banked,100);
});
test("team risks double through exactly six rungs and cannot risk beyond 3200",()=>{
  const room=decision();let now=4000;
  for(let index=0;index<6;index++){for(const p of room.members)p.seenAt=now;choose(room,now);answer(room,true,now+1000);assert.equal(room.game.pot,100*2**index);advanceRoom(room,now+6000);now+=7000;}
  assert.equal(room.game.ladder,6);assert.equal(room.game.pot,3200);assert.equal(projectRoom(room,"a",now).team.canRisk,false);
  assert.throws(()=>applyRoomCommand(room,room.activePlayerId!,command(room,"risk"),catalog,now));
  applyRoomCommand(room,room.activePlayerId!,command(room,"bank"),catalog,now);assert.equal(room.game.banked,3200);assert.equal(room.game.ladder,0);
});
test("incorrect choices lose the shared pot and one life, including a visible final failure before completion",()=>{
  const room=decision();choose(room,4000);answer(room,true,5000);advanceRoom(room,10000);choose(room,11000);answer(room,false,12000);
  assert.equal(room.game.pot,0);assert.equal(room.game.lives,2);assert.equal(room.recentTurns.at(-1)?.lostPot,100);advanceRoom(room,17000);
  choose(room,18000);answer(room,false,19000);advanceRoom(room,24000);choose(room,25000);answer(room,false,26000);
  assert.equal(room.game.lives,0);assert.equal(room.phase,"reveal");assert.ok(projectRoom(room,"a",26000).pair);assert.equal(projectRoom(room,"a",26000).completionStatus,undefined);
  advanceRoom(room,30999);assert.equal(room.phase,"reveal");advanceRoom(room,31000);assert.equal(room.phase,"complete");assert.equal(projectRoom(room,"a",31000).completionStatus,"completed");assert.equal(room.game.endReason,"lives");
});
test("guess timeout is exactly twenty seconds and even a late observer gets five seconds of reveal",()=>{
  const room=decision();choose(room,4000);advanceRoom(room,23999);assert.equal(room.game.lives,3);advanceRoom(room,90000);assert.equal(room.game.lives,2);assert.equal(room.phase,"reveal");assert.equal(room.revealUntil,95000);assert.equal(room.recentTurns.at(-1)?.timedOut,true);advanceRoom(room,90001);assert.equal(room.game.lives,2);
});
test("decision disconnect passes the untouched pot, all-offline pauses, heartbeat resumes without a penalty",()=>{
  const room=decision();choose(room,4000);answer(room,true,5000);advanceRoom(room,10000);assert.equal(room.activePlayerId,"b");
  room.members[0].seenAt=60000;advanceRoom(room,60000);assert.equal(room.activePlayerId,"a");assert.equal(room.game.pot,100);assert.equal(room.game.lives,3);
  const oldTurn=room.turn;advanceRoom(room,110000);assert.equal(room.phase,"paused");assert.equal(room.activePlayerId,null);assert.equal(room.game.pot,100);
  applyRoomCommand(room,"b",{...command(room,"heartbeat"),turn:oldTurn},undefined,111000);assert.equal(room.phase,"decision");assert.equal(room.activePlayerId,"b");assert.equal(room.game.pot,100);assert.equal(room.game.lives,3);
});
test("leaving during a committed hard pick cannot dodge its timeout, while all leaving ends incomplete",()=>{
  const room=decision();choose(room,4000);applyRoomCommand(room,"a",command(room,"leave"),undefined,5000);assert.equal(room.phase,"guess");assert.equal(room.activePlayerId,"a");assert.equal(room.game.guessDeadline,24000);assert.equal(room.hostId,"b");advanceRoom(room,24000);assert.equal(room.game.lives,2);assert.equal(room.phase,"reveal");advanceRoom(room,29000);assert.equal(room.activePlayerId,"b");
  room.game.banked=500;room.game.pot=200;applyRoomCommand(room,"b",command(room,"leave"),undefined,30000);assert.equal(room.phase,"complete");assert.equal(room.game.completionStatus,"incomplete");assert.equal(room.game.banked,500);assert.equal(room.game.pot,0);
});
test("lobby enforces capacity, unique names, readiness, and refuses active-run replacement players",()=>{
  const room=lobby();assert.throws(()=>joinRoomState(room,{id:"c",name:"alice"},1000),{code:"name_taken"});assert.throws(()=>applyRoomCommand(room,"b",command(room,"start"),undefined,2000),{code:"host_only"});assert.throws(()=>applyRoomCommand(room,"a",command(room,"start"),undefined,2000),{code:"not_ready"});
  for(let i=0;i<6;i++)joinRoomState(room,{id:`p${i}`,name:`Player ${i}`},2000);assert.throws(()=>joinRoomState(room,{id:"overflow",name:"Overflow"},2000),{code:"room_full"});
  const started=decision();assert.throws(()=>joinRoomState(started,{id:"late",name:"Late"},5000),{code:"match_started"});joinRoomState(started,{id:"a",name:"Changed"},5000);assert.equal(started.members[0].name,"Alice");assert.equal(started.members.length,2);
});
test("rematches reset team scores and readiness, preserve the collection, and are idempotent",()=>{
  const room=decision();room.game.lives=1;choose(room,4000);answer(room,false,5000);advanceRoom(room,10000);const old=room.matchId;const rematch=command(room,"rematch");
  applyRoomCommand(room,"a",rematch,catalog,11000);const fresh=room.matchId;assert.notEqual(fresh,old);assert.equal(room.phase,"lobby");assert.equal(room.game.catalogVersion,catalog.version);assert.equal(room.game.lives,3);assert.equal(room.game.banked,0);assert.ok(room.members.every(p=>!p.ready));
  applyRoomCommand(room,"a",rematch,catalog,12000);assert.equal(room.matchId,fresh);assert.throws(()=>applyRoomCommand(room,"a",{...command(room,"pick"),matchId:old},catalog,13000),{code:"stale_turn"});
});
test("defensive run and bank ceilings still use the original engine",()=>{
  const room=decision();room.game.answered=MAX_COMPARISONS-1;room.game.phase="miss";choose(room,4000);answer(room,true,5000);assert.equal(room.game.endReason,"run-limit");assert.equal(room.phase,"reveal");advanceRoom(room,10000);assert.equal(room.phase,"complete");
  const score=decision();choose(score,4000);answer(score,true,5000);advanceRoom(score,10000);score.game.banked=MAX_BANKED_POINTS-50;applyRoomCommand(score,score.activePlayerId!,command(score,"bank"),catalog,11000);assert.equal(score.game.banked,MAX_BANKED_POINTS);assert.equal(score.phase,"complete");assert.equal(score.game.endReason,"score-limit");
});
