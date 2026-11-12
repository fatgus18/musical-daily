import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Database} from "@musical-daily/database";
import {catalogVersion,type Catalog,type CatalogTrack} from "../src/lib/catalog.ts";
import {persistArtistCatalog,loadSavedCatalog} from "../src/lib/catalog-storage.ts";
import {openStore,pruneStore,saveGame} from "../src/lib/store.ts";
import {createGame} from "../src/lib/engine.ts";
import {winner} from "../src/lib/rules.ts";
import {createRoom,ensureRoomSchema,joinRoom,readRoom,commandRoom,findCreatedRoom,findRematchedRoom,pruneRooms} from "../src/lib/rooms/store.ts";
import type {PublicRoom,RoomAction,RoomCommand,RoomState} from "../src/lib/rooms/types.ts";

const tracks:CatalogTrack[]=Array.from({length:40},(_,i)=>({id:`room-track-${i}`,title:`Test ${i}`,artist:`Artist ${i%4}`,artwork:"https://example.com/art.jpg",sourceUrl:"https://example.com/catalog",genre:"pop",metrics:{duration:{value:100+i*5,sourceUrl:"https://example.com/duration"},streams:{value:100000*(i+1),sourceUrl:"https://example.com/streams",asOf:"2026-11-12"}}}));
const sources=[{id:"fixture",url:"https://example.com",note:"Fixture only"}];
const catalog:Catalog={schema:1,version:catalogVersion(tracks,sources),createdAt:"2026-11-12T00:00:00.000Z",tracks,sources};
let sequence=0;
const command=(r:PublicRoom,action:RoomAction,extra:Partial<RoomCommand>={}):RoomCommand=>({action,matchId:r.matchId,turn:r.turn,requestId:`request-${++sequence}`,...extra});
async function setup(path=":memory:"){const db=await openStore(path);await ensureRoomSchema(db);await persistArtistCatalog(catalog,db,1000);return db;}
async function fixture(){const db=await setup();const room=await createRoom(db,{id:"a",name:"Alice"},catalog,"create",{},()=>1000);await joinRoom(db,room.code,{id:"b",name:"Bob"},()=>1000);return{db,room};}
async function privateState(db:Database,code:string):Promise<RoomState>{return JSON.parse(String((await db.execute("SELECT state FROM double_drop_rooms WHERE code=?",[code])).rows[0].state));}
async function start(db:Database,room:PublicRoom){for(const id of ["a","b"])await commandRoom(db,room.code,id,command(room,"ready",{ready:true}),undefined,()=>2000);return commandRoom(db,room.code,"a",command(room,"start"),undefined,()=>3000);}
test("concurrent room creates are idempotent and racing joins cannot exceed eight members",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"drop-room-store-"));const path=join(folder,"test.sqlite");const db=await setup(path);const other=await openStore(path);
  try{
    const created=await Promise.all([createRoom(db,{id:"a",name:"Alice"},catalog,"create",{},()=>1000),createRoom(other,{id:"a",name:"Alice"},catalog,"create",{},()=>1000)]);assert.equal(created[0].code,created[1].code);assert.match(created[0].code,/^[A-HJ-NP-Z2-9]{6}$/);
    const joined=await Promise.allSettled(Array.from({length:12},(_,i)=>joinRoom(i%2?db:other,created[0].code,{id:`p${i}`,name:`Player ${i}`},()=>2000)));
    assert.equal(joined.filter(item=>item.status==="fulfilled").length,7);assert.equal((await readRoom(db,created[0].code,"a",()=>3000)).players.length,8);
    assert.ok(joined.filter(item=>item.status==="rejected").every(item=>item.status==="rejected"&&item.reason.code==="room_full"));
  }finally{db.close();other.close();await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("private membership, host ownership, stale turns, and hidden pair boundaries are enforced",async()=>{
  const {db,room}=await fixture();try{
    await assert.rejects(readRoom(db,room.code,"intruder",()=>2000),{code:"not_member"});
    await assert.rejects(commandRoom(db,room.code,"intruder",command(room,"start"),undefined,()=>2000),{code:"not_member"});
    await assert.rejects(commandRoom(db,room.code,"b",command(room,"start"),undefined,()=>2000),{code:"host_only"});
    const decision=await start(db,room);assert.equal(decision.pair,undefined);
    await assert.rejects(commandRoom(db,room.code,"b",command(decision,"pick"),catalog,()=>4000),{code:"not_your_turn"});
    await assert.rejects(commandRoom(db,room.code,"a",{...command(decision,"pick"),turn:99},catalog,()=>4000),{code:"stale_turn"});
    assert.equal((await readRoom(db,room.code,"a",()=>4000)).pair,undefined);
    await assert.rejects(joinRoom(db,room.code,{id:"late",name:"Late"},()=>4000),{code:"match_started"});
  }finally{db.close();}
});
test("steady room polling is one read with no write or identity-dependent cache",async()=>{
  const {db,room}=await fixture();try{
    let reads=0,writes=0;const measured:Database={...db,execute:async(...args)=>{reads++;return db.execute(...args);},transaction:async fn=>{writes++;return db.transaction(fn);}};
    await readRoom(measured,room.code,"a",()=>3000);assert.equal(reads,1);assert.equal(writes,0);await readRoom(measured,room.code,"b",()=>4000);assert.equal(reads,2);assert.equal(writes,0);
  }finally{db.close();}
});
test("clock is checked after acquiring the write lock; a queued late answer times out only once",async()=>{
  const {db,room}=await fixture();try{
    const decision=await start(db,room);const guessing=await commandRoom(db,room.code,"a",command(decision,"pick"),catalog,()=>4000);const state=await privateState(db,room.code);
    let release!:()=>void;let entered!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});const inside=new Promise<void>(resolve=>{entered=resolve;});
    const blocker=db.transaction(async()=>{entered();await barrier;});await inside;
    let now=5000,calls=0;const move=commandRoom(db,room.code,"a",command(guessing,"guess",{choice:winner(state.game.pair)}),undefined,()=>{calls++;return now;});
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,0);now=25000;release();await blocker;
    await assert.rejects(move,{code:"room_conflict"});const revealed=await readRoom(db,room.code,"a",()=>25001);
    assert.equal(revealed.phase,"reveal");assert.equal(revealed.team.lives,2);assert.equal(revealed.team.correct,0);assert.equal(revealed.reveal?.timedOut,true);assert.equal(revealed.revealUntil,30000);
  }finally{db.close();}
});
test("concurrent answer retries score one team result and cannot write solo stats or account outboxes",async()=>{
  const {db,room}=await fixture();try{
    const decision=await start(db,room);const guessing=await commandRoom(db,room.code,"a",command(decision,"pick"),catalog,()=>4000);const state=await privateState(db,room.code);const answer=command(guessing,"guess",{choice:winner(state.game.pair)});
    const results=await Promise.all(Array.from({length:5},()=>commandRoom(db,room.code,"a",answer,undefined,()=>5000)));assert.ok(results.every(result=>result.team.pot===100&&result.team.answered===1));assert.equal(results[0].recentTurns.length,1);
    assert.equal(Number((await db.execute("SELECT count(*) n FROM games")).rows[0].n),0);assert.equal(Number((await db.execute("SELECT count(*) n FROM account_result_outbox")).rows[0].n),0);
    const next=await readRoom(db,room.code,"b",()=>10000);assert.equal(next.activePlayerId,"b");const bank=command(next,"bank");await Promise.all([commandRoom(db,room.code,"b",bank,catalog,()=>11000),commandRoom(db,room.code,"b",bank,catalog,()=>11000)]);
    const banked=await readRoom(db,room.code,"a",()=>12000);assert.equal(banked.team.banked,100);assert.equal(banked.guessDeadline,31000);
  }finally{db.close();}
});
test("room state and its discovered artist snapshot survive closing and reopening storage",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"drop-room-reopen-"));const path=join(folder,"test.sqlite");let db=await setup(path);
  try{
    const room=await createRoom(db,{id:"a",name:"Alice"},catalog,"reopen",{theme:"pop",metricFilter:"duration"},()=>1000);await joinRoom(db,room.code,{id:"b",name:"Bob"},()=>2000);
    db.close();db=await openStore(path);await ensureRoomSchema(db);
    const rejoined=await joinRoom(db,room.code,{id:"a",name:"New name"},()=>3000);assert.equal(rejoined.players.length,2);assert.equal(rejoined.players[0].name,"Alice");assert.equal(rejoined.catalogVersion,catalog.version);assert.equal(rejoined.theme,"pop");assert.equal((await loadSavedCatalog(catalog.version,db)).tracks.length,40);
    assert.equal((await findCreatedRoom(db,"a","reopen",()=>3000))?.code,room.code);assert.equal(await findCreatedRoom(db,"other","reopen",()=>3000),undefined);
  }finally{db.close();await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("room pins protect old live snapshots, extend with room activity, and release without disturbing solo pins",async()=>{
  const {db,room}=await fixture();try{
    const now=50*86400000;await db.execute("UPDATE catalog_snapshots SET last_used_at=0");await db.execute("UPDATE catalog_room_pins SET expires_at=? WHERE room_code=?",[now+10000,room.code]);
    await pruneStore(db,now,true);assert.equal(Number((await db.execute("SELECT count(*) n FROM catalog_snapshots")).rows[0].n),1);
    await db.execute("UPDATE catalog_room_pins SET expires_at=0 WHERE room_code=?",[room.code]);
    const solo=createGame("solo",catalog,"solo",{},now);await saveGame(db,solo);await pruneStore(db,now+1,true);assert.equal(Number((await db.execute("SELECT count(*) n FROM catalog_snapshots")).rows[0].n),1);
    await db.execute("DELETE FROM games WHERE id=?",[solo.id]);await pruneStore(db,now+2,true);assert.equal(Number((await db.execute("SELECT count(*) n FROM catalog_snapshots")).rows[0].n),0);
  }finally{db.close();}
});
test("rematch responses are idempotent and expired rooms and pins are pruned together",async()=>{
  const {db,room}=await fixture();try{
    const state=await privateState(db,room.code);state.phase="complete";state.game.phase="complete";state.game.completionStatus="completed";state.game.endReason="lives";
    await db.execute("UPDATE double_drop_rooms SET state=? WHERE code=?",[JSON.stringify(state),room.code]);const rematch=command(room,"rematch");
    const fresh=await commandRoom(db,room.code,"a",rematch,catalog,()=>3000);assert.notEqual(fresh.matchId,room.matchId);assert.equal((await findRematchedRoom(db,room.code,"a",rematch.requestId!,()=>4000))?.matchId,fresh.matchId);
    assert.equal((await commandRoom(db,room.code,"a",rematch,catalog,()=>5000)).matchId,fresh.matchId);await assert.rejects(findRematchedRoom(db,room.code,"b",rematch.requestId!,()=>5000),{code:"host_only"});
    await assert.rejects(readRoom(db,room.code,"a",()=>5000+2*60*60*1000),{code:"room_expired"});assert.equal(await pruneRooms(db,5000+2*60*60*1000),1);assert.equal(Number((await db.execute("SELECT count(*) n FROM catalog_room_pins")).rows[0].n),0);
  }finally{db.close();}
});
