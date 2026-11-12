import {test} from "node:test";
import assert from "node:assert/strict";
import type {ArtistPool,Track} from "../src/lib/catalog.ts";
import {advanceRoom,applyRoomCommand,createRoomState,joinRoomState,projectRoom,roomStandings} from "../src/lib/rooms/engine.ts";
import type {RoomCommand,RoomState} from "../src/lib/rooms/types.ts";

const tracks:Track[]=Array.from({length:60},(_,i)=>({id:`song-${i}`,title:`Private song ${i}`,aliases:[],artistId:"123",artist:"Fixture Artist",preview:`https://audio-ssl.itunes.apple.com/secret-${i}.m4a`,artwork:"https://is1-ssl.mzstatic.com/art.jpg",url:`https://music.apple.com/us/song/${i}`,duration:200,rank:1000-i}));
const pool:ArtistPool={artist:{id:"123",name:"Fixture Artist",image:"",url:"https://music.apple.com/artist/123"},tracks,ranking:{kind:"provider-rank",label:"Fixture",sourceUrl:"https://example.com",asOf:"2026-11-12"},fetchedAt:1};
const command=(room:RoomState,action:RoomCommand["action"],rest:Partial<RoomCommand>={}):RoomCommand=>({action,matchId:room.matchId,round:room.round,...rest});
function lobby(){const room=createRoomState("ABC234",{id:"a",name:"Alice"},pool,"create-1",1000);joinRoomState(room,{id:"b",name:"Bob"},1000);return room;}
function playing(){const room=lobby();for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"ready",{ready:true}),undefined,2000);applyRoomCommand(room,"a",command(room,"start"),undefined,3000);for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"loaded",{audioRevision:room.audioRevision}),undefined,4000);return room;}
test("real artist selection is shared, opaque, and never exposes private audio or future answers",()=>{
  const room=playing();assert.equal(room.picks.length,10);assert.equal(new Set(room.picks.map(p=>p.track.id)).size,10);
  assert.deepEqual(room.picks.reduce((counts,p)=>(counts[p.tier]=(counts[p.tier]??0)+1,counts),{} as Record<string,number>),{hit:6,favorite:3,deep:1});
  const publicRoom=projectRoom(room,"a",8000);const encoded=JSON.stringify(publicRoom);
  for(const value of ["Private song","secret-","correctChoiceId",'"picks"','"answer":'])assert.equal(encoded.includes(value),false,value);
  assert.equal(publicRoom.choices,undefined);assert.equal(publicRoom.startAt,8000);
  assert.throws(()=>projectRoom(room,"intruder",8000),{code:"not_member"});
  for(const pick of room.picks){assert.equal(pick.choices?.length,4);assert.match(pick.correctChoiceId!,/^[\da-f-]{36}$/);}
});
test("early guessing shortens personal time, hides correctness until all lock in, and forbids rewinding",()=>{
  const room=playing();const start=room.startAt!;
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"guess"),undefined,start-1),{code:"round_not_playing"});
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+5000),{code:"guess_not_open"});
  applyRoomCommand(room,"a",command(room,"guess"),undefined,start+5000);
  const visible=projectRoom(room,"a",start+5000);assert.equal(visible.you.guessDeadline,start+20000);assert.equal(visible.choices?.length,4);
  assert.equal(projectRoom(room,"b",start+5000).choices,undefined);
  applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+6234);
  assert.equal(projectRoom(room,"a",start+6234).leaderboard[0].score,0);
  assert.equal(projectRoom(room,"b",start+6234).reveals.length,0);
  assert.equal(JSON.stringify(projectRoom(room,"b",start+6234)).includes(room.picks[0].correctChoiceId!),false);
  applyRoomCommand(room,"a",command(room,"pass"),undefined,start+7000);assert.equal(room.members[0].answer?.correct,true);
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"retry"),undefined,start+7000));
  const natural=projectRoom(room,"b",start+15000);assert.equal(natural.choices?.length,4);assert.equal(natural.you.guessAt,start+15000);assert.equal(natural.you.guessDeadline,start+30000);
  applyRoomCommand(room,"b",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+18000);
  assert.equal(room.phase,"reveal");assert.equal(room.reveals[0].answers.find(a=>a.playerId==="a")?.elapsedMs,6200);
  assert.equal(roomStandings(room)[0].id,"a");assert.equal(roomStandings(room)[0].score,1000);
});
test("deadlines score only once, use server time, and cannot be extended with late guess requests",()=>{
  const room=playing();const start=room.startAt!;
  applyRoomCommand(room,"a",command(room,"guess"),undefined,start+1000);
  advanceRoom(room,start+16000);assert.equal(room.members[0].answer?.timedOut,true);assert.equal(room.phase,"playing");
  applyRoomCommand(room,"b",command(room,"guess"),undefined,start+28000);assert.equal(projectRoom(room,"b",start+28000).you.guessDeadline,start+30000);
  applyRoomCommand(room,"b",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+30000);
  assert.equal(room.phase,"reveal");assert.equal(room.reveals.length,1);assert.equal(room.reveals[0].answers.every(a=>!a.correct),true);
  advanceRoom(room,start+30001);assert.equal(room.reveals.length,1);
  advanceRoom(room,start+35000);assert.equal(room.phase,"loading");assert.equal(room.round,1);
  assert.throws(()=>applyRoomCommand(room,"a",{action:"answer",matchId:room.matchId,round:0,choiceId:room.picks[0].correctChoiceId},undefined,start+35000),{code:"stale_round"});
});
test("unavailable previews void the same round for everybody, retries invalidate old readiness",()=>{
  const room=lobby();for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"ready",{ready:true}),undefined,2000);
  applyRoomCommand(room,"a",command(room,"start"),undefined,3000);const oldRevision=room.audioRevision;
  applyRoomCommand(room,"a",command(room,"loaded",{audioRevision:oldRevision}),undefined,4000);
  applyRoomCommand(room,"a",command(room,"retry"),undefined,5000);assert.equal(room.members[0].loaded,false);
  assert.throws(()=>applyRoomCommand(room,"b",command(room,"loaded",{audioRevision:oldRevision}),undefined,6000),{code:"stale_audio"});
  assert.throws(()=>applyRoomCommand(room,"b",command(room,"skip"),undefined,6000),{code:"host_only"});
  advanceRoom(room,40000);assert.equal(room.phase,"reveal");assert.equal(room.reveals[0].voided,true);assert.equal(room.reveals[0].reason,"preview_unavailable");
  assert.equal(roomStandings(room).every(p=>p.score===0),true);
});
test("lobby protects capacity, readiness, nickname identity, and stale host takeover",()=>{
  const room=lobby();assert.throws(()=>joinRoomState(room,{id:"c",name:"ALICE"},1000),{code:"name_taken"});
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"start"),undefined,2000),{code:"not_ready"});
  assert.throws(()=>applyRoomCommand(room,"b",command(room,"start"),undefined,2000),{code:"host_only"});
  for(let i=0;i<6;i++)joinRoomState(room,{id:`p${i}`,name:`Player ${i}`},2000);
  assert.throws(()=>joinRoomState(room,{id:"extra",name:"Extra"},2000),{code:"room_full"});
  applyRoomCommand(room,"b",command(room,"heartbeat"),undefined,47000);advanceRoom(room,47001);assert.equal(room.hostId,"b");
  applyRoomCommand(room,"b",command(room,"leave"),undefined,47002);assert.equal(room.hostId,"a");
  const activeRoom=playing();assert.throws(()=>joinRoomState(activeRoom,{id:"late",name:"Late"},9000),{code:"match_started"});
  joinRoomState(activeRoom,{id:"a",name:"Changed name"},9000);assert.equal(activeRoom.members.length,2);assert.equal(activeRoom.members[0].name,"Alice");
});
test("full ten-round game ranks correctness first, allows exact ties, and rematches are idempotent",()=>{
  const room=playing();const previousPicks=room.picks.map(p=>p.track.id);
  for(let round=0;round<10;round++){
    if(round>0){const loadedAt=room.loadingDeadline!-35000+100;for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"loaded",{audioRevision:room.audioRevision}),undefined,loadedAt);}
    const start=room.startAt!;
    for(const id of ["a","b"]){applyRoomCommand(room,id,command(room,"guess"),undefined,start+1000);applyRoomCommand(room,id,command(room,"answer",{choiceId:room.picks[round].correctChoiceId}),undefined,start+2000);}
    advanceRoom(room,start+7000);
  }
  assert.equal(room.phase,"complete");assert.equal(room.reveals.length,10);assert.deepEqual(roomStandings(room).map(p=>[p.score,p.timeMs,p.rank,p.winner]),[[10000,20000,1,true],[10000,20000,1,true]]);
  const rematch=command(room,"rematch",{requestId:"rematch-1"});const oldMatch=room.matchId;
  applyRoomCommand(room,"a",rematch,pool,2000000);const newMatch=room.matchId;assert.notEqual(newMatch,oldMatch);assert.equal(room.phase,"lobby");
  assert.equal(room.picks.filter(p=>previousPicks.includes(p.track.id)).length,0);assert.equal(room.members.every(p=>!p.ready),true);
  applyRoomCommand(room,"a",rematch,pool,2000001);assert.equal(room.matchId,newMatch);
  assert.throws(()=>applyRoomCommand(room,"b",{...rematch,requestId:"other"},pool,2000002),{code:"stale_round"});
});
test("small unranked artists still get ten distinct shared discovery songs",()=>{
  const discovery={...pool,tracks:tracks.slice(0,12),ranking:{...pool.ranking,kind:"unranked" as const}};
  const room=createRoomState("ABC234",{id:"a",name:"Alice"},discovery,"d",0);assert.equal(room.picks.length,10);assert.ok(room.picks.every(p=>p.tier==="discovery"));
});
test("leaving forfeits winning but preserves earned points and promotes an existing host",()=>{
  const room=playing();const start=room.startAt!;
  applyRoomCommand(room,"a",command(room,"guess"),undefined,start+1000);
  applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+2000);
  applyRoomCommand(room,"b",command(room,"guess"),undefined,start+2000);
  applyRoomCommand(room,"b",command(room,"pass"),undefined,start+3000);
  applyRoomCommand(room,"a",command(room,"leave"),undefined,start+4000);assert.equal(room.hostId,"b");
  room.phase="complete";
  const standings=roomStandings(room);assert.equal(standings.find(p=>p.id==="a")?.score,1000);assert.equal(standings.find(p=>p.id==="a")?.winner,false);assert.equal(standings.find(p=>p.id==="b")?.winner,false);
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"heartbeat"),undefined,start+5000),{code:"player_left"});
});
test("more correct songs outrank speed and invalid current choices never consume an answer",()=>{
  const room=playing();const start=room.startAt!;
  applyRoomCommand(room,"a",command(room,"guess"),undefined,start+1000);
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[1].correctChoiceId}),undefined,start+2000),{code:"invalid_choice"});
  assert.equal(room.members[0].answer,null);
  applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+3000);
  applyRoomCommand(room,"b",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,start+28000);
  const first=structuredClone(room.reveals[0]);first.round=1;first.answers.find(a=>a.playerId==="a")!.correct=false;room.reveals.push(first);
  const standings=roomStandings(room);assert.equal(standings[0].id,"b");assert.equal(standings[0].correct,2);assert.equal(standings[1].correct,1);
});
test("a disconnected host cannot stall every clip, and reconnecting never resets the shared clock",()=>{
  const room=lobby();for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"ready",{ready:true}),undefined,2000);
  applyRoomCommand(room,"a",command(room,"start"),undefined,3000);
  applyRoomCommand(room,"b",command(room,"loaded",{audioRevision:room.audioRevision}),undefined,4000);
  applyRoomCommand(room,"b",command(room,"heartbeat"),undefined,30000);
  advanceRoom(room,38000);assert.equal(room.reveals[0].voided,true);
  advanceRoom(room,43000);assert.equal(room.phase,"loading");assert.equal(room.round,1);
  applyRoomCommand(room,"b",command(room,"loaded",{audioRevision:room.audioRevision}),undefined,45000);
  assert.equal(room.phase,"loading");advanceRoom(room,49000);
  assert.equal(room.phase,"playing");assert.equal(room.hostId,"b");assert.equal(room.startAt,53000);
  assert.equal(room.members.find(p=>p.id==="a")?.left,false);
  joinRoomState(room,{id:"a",name:"Alice"},60000);
  assert.equal(room.startAt,53000);assert.equal(room.roundEnd,83000);
  applyRoomCommand(room,"a",command(room,"guess"),undefined,62000);
  assert.equal(projectRoom(room,"a",62000).you.guessDeadline,77000);
  applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[1].correctChoiceId}),undefined,64000);
  assert.equal(room.members.find(p=>p.id==="a")?.answer?.elapsedMs,11000);
});
test("loading excludes an absent member without deleting their identity or scoring a missing answer early",()=>{
  const room=lobby();for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"ready",{ready:true}),undefined,2000);
  applyRoomCommand(room,"a",command(room,"start"),undefined,3000);
  room.loadingDeadline=70000;
  applyRoomCommand(room,"a",command(room,"loaded",{audioRevision:room.audioRevision}),undefined,50000);
  assert.equal(room.phase,"playing");assert.equal(room.startAt,54000);
  applyRoomCommand(room,"a",command(room,"guess"),undefined,55000);
  applyRoomCommand(room,"a",command(room,"answer",{choiceId:room.picks[0].correctChoiceId}),undefined,56000);
  assert.equal(room.phase,"playing");assert.equal(room.members.find(p=>p.id==="b")?.answer,null);
  advanceRoom(room,84000);assert.equal(room.phase,"reveal");assert.equal(room.reveals[0].voided,false);
  assert.equal(room.reveals[0].answers.find(p=>p.playerId==="b")?.timedOut,true);
});
test("zero correct songs never declare a room winner and wrong or passed answer speed is excluded",()=>{
  const room=playing();const start=room.startAt!;
  for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"guess"),undefined,start+1000);
  const wrong=room.picks[0].choices!.find(c=>c.id!==room.picks[0].correctChoiceId)!.id;
  applyRoomCommand(room,"a",command(room,"answer",{choiceId:wrong}),undefined,start+2000);
  applyRoomCommand(room,"b",command(room,"pass"),undefined,start+3000);
  room.phase="complete";
  assert.ok(roomStandings(room).every(p=>p.score===0&&p.timeMs===0&&p.rank===1&&!p.winner));
  room.reveals[0].voided=true;assert.ok(roomStandings(room).every(p=>!p.winner));
});
test("an offline unready lobby guest cannot block two present ready players from starting",()=>{
  const room=lobby();joinRoomState(room,{id:"c",name:"Cleo"},1000);
  applyRoomCommand(room,"a",command(room,"ready",{ready:true}),undefined,50000);
  assert.throws(()=>applyRoomCommand(room,"a",command(room,"start"),undefined,50000),{code:"not_ready"});
  applyRoomCommand(room,"b",command(room,"ready",{ready:true}),undefined,50001);
  applyRoomCommand(room,"a",command(room,"start"),undefined,50002);
  assert.equal(room.phase,"loading");assert.equal(room.members.length,3);assert.equal(room.members.find(p=>p.id==="c")?.left,false);
  for(const id of ["a","b"])applyRoomCommand(room,id,command(room,"loaded",{audioRevision:room.audioRevision}),undefined,51000);
  assert.equal(room.phase,"playing");assert.equal(room.startAt,55000);
  joinRoomState(room,{id:"c",name:"Cleo"},60000);
  assert.equal(room.startAt,55000);assert.equal(room.roundEnd,85000);
});
test("artist mode is durable, legacy rooms default to chosen, and random rematches preserve their mode",()=>{
  const room=createRoomState("ABC234",{id:"a",name:"Alice"},pool,"random-create",1000,"random");
  assert.equal(room.artistMode,"random");assert.equal(projectRoom(room,"a",1000).artistMode,"random");
  const restored=JSON.parse(JSON.stringify(room)) as RoomState;assert.equal(projectRoom(restored,"a",1000).artistMode,"random");
  const replacement={...pool,artist:{...pool.artist,id:"456",name:"Another Artist"},tracks:pool.tracks.map(t=>({...t,artistId:"456",artist:"Another Artist"}))};
  room.phase="complete";const rematch=command(room,"rematch",{requestId:"random-rematch",artistMode:"chosen"});
  applyRoomCommand(room,"a",rematch,replacement,2000);assert.equal(room.artist.id,"456");assert.equal(room.artistMode,"random");
  applyRoomCommand(room,"a",command(room,"configure",{requestId:"chosen-config",artistMode:"chosen"}),pool,3000);
  assert.equal(room.artist.id,"123");assert.equal(projectRoom(room,"a",3000).artistMode,"chosen");
  delete room.artistMode;assert.equal(projectRoom(room,"a",3000).artistMode,"chosen");
});
