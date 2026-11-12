import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openLocalDatabase,type Database} from "@musical-daily/database";
import type {ArtistPool,Track} from "../src/lib/catalog.ts";
import {createRoom,findCreatedRoom,findRematchedRoom,joinRoom,readRoom,commandRoom,ensureRoomSchema,roomAudioTrack,pruneRooms} from "../src/lib/rooms/store.ts";
import type {PublicRoom,RoomCommand,RoomState} from "../src/lib/rooms/types.ts";

const tracks:Track[]=Array.from({length:60},(_,i)=>({id:`track-${i}`,title:`Fixture ${i}`,aliases:[],artistId:"42",artist:"Store Artist",preview:`https://audio-ssl.itunes.apple.com/private-${i}.m4a`,artwork:"",url:"https://music.apple.com",duration:200,rank:100-i}));
const pool:ArtistPool={artist:{id:"42",name:"Store Artist",image:"",url:"https://music.apple.com/artist/42"},tracks,ranking:{kind:"provider-rank",label:"fixture",sourceUrl:"https://example.com",asOf:"2026-11-12"},fetchedAt:1};
const command=(room:PublicRoom,action:RoomCommand["action"],rest:Partial<RoomCommand>={}):RoomCommand=>({action,matchId:room.matchId,round:room.round,...rest});
async function privateState(db:Database,code:string){return JSON.parse(String((await db.execute("SELECT state FROM encore_rooms WHERE code=?",[code])).rows[0].state)) as RoomState;}
async function fixture(){const db=openLocalDatabase(":memory:");await ensureRoomSchema(db);const room=await createRoom(db,{id:"a",name:"Alice"},pool,"create",1000);await joinRoom(db,room.code,{id:"b",name:"Bob"},1000);return{db,room};}
async function start(db:Database,room:PublicRoom){for(const id of ["a","b"])await commandRoom(db,room.code,id,command(room,"ready",{ready:true}),undefined,2000);await commandRoom(db,room.code,"a",command(room,"start"),undefined,3000);for(const id of ["a","b"])room=await commandRoom(db,room.code,id,command(room,"loaded",{audioRevision:room.audioRevision}),undefined,4000);return room;}

test("random artist mode persists and creation retries retrieve the original shared selection",async()=>{
  const db=openLocalDatabase(":memory:");await ensureRoomSchema(db);
  try{
    assert.equal(await findCreatedRoom(db,"a","random-create",1000),undefined);
    const created=await createRoom(db,{id:"a",name:"Alice"},pool,"random-create",1000,"random");
    const friend=await joinRoom(db,created.code,{id:"b",name:"Bob"},2000);
    assert.equal(created.artistMode,"random");assert.equal(friend.artistMode,"random");assert.deepEqual(friend.artist,created.artist);
    const recovered=await findCreatedRoom(db,"a","random-create",3000);
    assert.equal(recovered?.code,created.code);assert.equal(recovered?.matchId,created.matchId);assert.deepEqual(recovered?.artist,created.artist);
    assert.equal(await findCreatedRoom(db,"b","random-create",3000),undefined);
    assert.equal((await privateState(db,created.code)).artistMode,"random");
  }finally{db.close();}
});

test("random rematch retries recover the same new artist and cannot disclose another host's room",async()=>{
  const {db,room}=await fixture();
  try{
    const state=await privateState(db,room.code);state.artistMode="random";state.phase="complete";
    await db.execute("UPDATE encore_rooms SET state=? WHERE code=?",[JSON.stringify(state),room.code]);
    const nextPool={...pool,artist:{...pool.artist,id:"43",name:"Next Artist"},tracks:pool.tracks.map(track=>({...track,artistId:"43",artist:"Next Artist"}))};
    assert.equal(await findRematchedRoom(db,room.code,"a","random-rematch",2000),undefined);
    const next=await commandRoom(db,room.code,"a",command(room,"rematch",{requestId:"random-rematch"}),nextPool,3000);
    const recovered=await findRematchedRoom(db,room.code,"a","random-rematch",4000);
    assert.equal(next.artistMode,"random");assert.equal(next.artist.id,"43");assert.equal(recovered?.matchId,next.matchId);assert.equal(recovered?.artist.id,"43");
    assert.equal(await findRematchedRoom(db,room.code,"a","another-rematch",4000),undefined);
    await assert.rejects(findRematchedRoom(db,room.code,"b","random-rematch",4000),{code:"host_only"});
    await assert.rejects(findRematchedRoom(db,room.code,"unknown","random-rematch",4000),{code:"not_member"});
  }finally{db.close();}
});
test("concurrent create is idempotent and eight-person capacity survives racing joins across DB handles",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"encore-rooms-test-"));const db=openLocalDatabase(join(dir,"rooms.sqlite"));const other=openLocalDatabase(join(dir,"rooms.sqlite"));
  try{
    await ensureRoomSchema(db);const requests=await Promise.all([createRoom(db,{id:"a",name:"Alice"},pool,"request",1000),createRoom(other,{id:"a",name:"Alice"},pool,"request",1000)]);
    assert.equal(requests[0].code,requests[1].code);const code=requests[0].code;assert.match(code,/^[A-HJ-NP-Z2-9]{6}$/);
    const joined=await Promise.allSettled(Array.from({length:12},(_,i)=>joinRoom(i%2?db:other,code,{id:`p${i}`,name:`Player ${i}`},2000)));
    assert.equal(joined.filter(r=>r.status==="fulfilled").length,7);assert.equal((await readRoom(db,code,"a",2001)).players.length,8);
    assert.ok(joined.filter(r=>r.status==="rejected").every(r=>r.status==="rejected"&&r.reason.code==="room_full"));
  }finally{db.close();other.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("membership guards reads, actions, and private audio; opaque code alone is never authentication",async()=>{
  const {db,room}=await fixture();try{
    await assert.rejects(readRoom(db,room.code,"intruder",2000),{status:401,code:"not_member"});
    await assert.rejects(commandRoom(db,room.code,"intruder",command(room,"start"),undefined,2000),{code:"not_member"});
    await assert.rejects(roomAudioTrack(db,room.code,"intruder",room.matchId,0,2000),{code:"not_member"});
    await assert.rejects(roomAudioTrack(db,room.code,"a",room.matchId,0,2000),{code:"audio_unavailable"});
    await assert.rejects(joinRoom(db,room.code,{id:"other",name:"alice"},2000),{code:"name_taken"});
    await assert.rejects(commandRoom(db,room.code,"b",command(room,"start"),undefined,2000),{code:"host_only"});
    await assert.rejects(readRoom(db,"123","a",2000),{code:"invalid_code"});
    await assert.rejects(readRoom(db,"ZZZZZZ","a",2000),{code:"room_not_found"});
  }finally{db.close();}
});
test("steady reads execute one query and never write heartbeat or revision",async()=>{
  const {db,room}=await fixture();try{
    let reads=0,writes=0;const counted:Database={...db,execute:async(...args)=>{reads++;return db.execute(...args);},transaction:async fn=>{writes++;return db.transaction(fn);}};
    const before=await readRoom(counted,room.code,"a",2000);assert.equal(reads,1);assert.equal(writes,0);
    await readRoom(counted,room.code,"a",3000);assert.equal(reads,2);assert.equal(writes,0);assert.equal((await readRoom(db,room.code,"a",4000)).revision,before.revision);
  }finally{db.close();}
});
test("server scores concurrent answers once, keeps secrets until reveal, and stops audio on early guess",async()=>{
  const {db,room:initial}=await fixture();try{
    const room=await start(db,initial);const state=await privateState(db,room.code);const startAt=room.startAt!;
    assert.equal((await roomAudioTrack(db,room.code,"a",room.matchId,0,startAt,room.audioRevision)).id,state.picks[0].track.id);
    await commandRoom(db,room.code,"a",command(room,"guess"),undefined,startAt+2000);
    await assert.rejects(roomAudioTrack(db,room.code,"a",room.matchId,0,startAt+2000,room.audioRevision),{code:"audio_closed"});
    const answer=command(room,"answer",{choiceId:state.picks[0].correctChoiceId});
    await Promise.all([commandRoom(db,room.code,"a",answer,undefined,startAt+3000),commandRoom(db,room.code,"a",answer,undefined,startAt+3000)]);
    const waiting=await readRoom(db,room.code,"b",startAt+3000);assert.equal(waiting.reveals.length,0);assert.equal(waiting.leaderboard.every(p=>p.score===0),true);assert.equal(waiting.choices,undefined);
    await commandRoom(db,room.code,"b",command(room,"guess"),undefined,startAt+5000);
    const revealed=await commandRoom(db,room.code,"b",answer,undefined,startAt+6000);assert.equal(revealed.phase,"reveal");assert.equal(revealed.reveals.length,1);assert.deepEqual(revealed.leaderboard.map(p=>[p.id,p.score,p.timeMs]),[["a",1000,3000],["b",1000,6000]]);
    const next=await readRoom(db,room.code,"a",startAt+11000);assert.equal(next.round,1);assert.equal(next.phase,"loading");
    await assert.rejects(commandRoom(db,room.code,"a",answer,undefined,startAt+12000),{code:"stale_round"});
    await assert.rejects(roomAudioTrack(db,room.code,"a",room.matchId,0,startAt+12000,room.audioRevision),{code:"stale_round"});
  }finally{db.close();}
});
test("state survives close/reopen, reconnects the same identity, and ignores an older match command",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"encore-rooms-reopen-"));const file=join(dir,"rooms.sqlite");let db=openLocalDatabase(file);
  try{
    await ensureRoomSchema(db);const room=await createRoom(db,{id:"a",name:"Alice"},pool,"reopen",1000);await joinRoom(db,room.code,{id:"b",name:"Bob"},2000);await commandRoom(db,room.code,"a",command(room,"ready",{ready:true}),undefined,3000);
    db.close();db=openLocalDatabase(file);await ensureRoomSchema(db);
    const restored=await joinRoom(db,room.code,{id:"a",name:"New name"},4000);assert.equal(restored.players.length,2);assert.equal(restored.you.ready,true);assert.equal(restored.players.find(p=>p.id==="a")?.name,"Alice");
    await assert.rejects(commandRoom(db,room.code,"a",{...command(room,"ready",{ready:false}),matchId:"old-match"},undefined,5000),{code:"stale_round"});
    assert.equal((await readRoom(db,room.code,"a",5000)).you.ready,true);
  }finally{db.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("expired rooms fail explicitly and bounded pruning removes at most twenty private states",async()=>{
  const {db,room}=await fixture();try{
    await assert.rejects(readRoom(db,room.code,"a",1000+2*60*60*1000),{code:"room_expired",status:410});
    const state=await privateState(db,room.code);
    for(let i=0;i<25;i++)await db.execute("INSERT INTO encore_rooms VALUES(?,?,?,?,?,?)",[`fixture-${i}`,"fixture",`request-${i}`,100,0,JSON.stringify(state)]);
    assert.equal(await pruneRooms(db,200),20);assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM encore_rooms")).rows[0].n),6);
    assert.equal(await pruneRooms(db,200),5);
  }finally{db.close();}
});
test("retry revision protects readiness and hosts cannot skip a playing clip",async()=>{
  const {db,room}=await fixture();try{
    for(const id of ["a","b"])await commandRoom(db,room.code,id,command(room,"ready",{ready:true}),undefined,2000);
    await commandRoom(db,room.code,"a",command(room,"start"),undefined,3000);
    const retried=await commandRoom(db,room.code,"a",command(room,"retry"),undefined,4000);
    await assert.rejects(commandRoom(db,room.code,"b",command(room,"loaded",{audioRevision:room.audioRevision}),undefined,5000),{code:"stale_audio"});
    await assert.rejects(roomAudioTrack(db,room.code,"a",room.matchId,0,5000,room.audioRevision),{code:"stale_round"});
    for(const id of ["a","b"])await commandRoom(db,room.code,id,command(room,"loaded",{audioRevision:retried.audioRevision}),undefined,6000);
    await assert.rejects(commandRoom(db,room.code,"a",command(room,"skip"),undefined,12000),{code:"room_conflict"});
    assert.equal((await readRoom(db,room.code,"a",12000)).phase,"playing");
  }finally{db.close();}
});
