import test from "node:test";
import assert from "node:assert/strict";
import {catalogVersion,type Catalog,type CatalogTrack} from "../src/lib/catalog.ts";
import {roomActor,roomBody,roomCommand,roomCreation,roomFailure,roomIdentity,roomReply,roomSettings,privateRoomRead} from "../src/lib/rooms/http.ts";

const origin="https://team.example.test";
const requestId="a-shared-request-1234";
const request=(body:unknown,headers:Record<string,string>={})=>new Request(`${origin}/api/rooms`,{method:"POST",headers:{origin,"content-type":"application/json",...headers},body:JSON.stringify(body)});
test("co-op writes require same-origin bounded JSON and reject untrusted score, clock and actor fields",async()=>{
  assert.deepEqual(await roomBody(request({action:"heartbeat"}),origin),{action:"heartbeat"});
  await assert.rejects(roomBody(request({}, {origin:"https://attacker.test"}),origin),{code:"invalid_origin"});
  await assert.rejects(roomBody(request({}, {"content-type":"text/plain"}),origin),{status:415});
  await assert.rejects(roomBody(request({text:"x".repeat(3000)}),origin),{status:413});
  await assert.rejects(roomBody(request([]),origin),{status:400});
  for(const extra of [{banked:100000},{lives:3},{serverNow:1},{playerId:"someone-else"},{revision:0}])assert.throws(()=>roomCommand({action:"pick",matchId:"match",turn:0,requestId,...extra}),{code:"invalid_body"});
  assert.throws(()=>privateRoomRead(new Request(origin,{headers:{"sec-fetch-site":"cross-site"}})),{code:"invalid_origin"});
});
test("co-op membership cookie is private and independent of Encore or solo identities",async()=>{
  const own=roomIdentity(new Request(origin));assert.match(own.token,/^[a-f0-9]{64}$/);assert.notEqual(own.id,own.token);
  const same=roomIdentity(new Request(origin,{headers:{cookie:`double_drop_room_player=${own.token}`}}));assert.equal(same.id,own.id);assert.equal(same.fresh,false);
  const unrelated=roomIdentity(new Request(origin,{headers:{cookie:`encore_room_player=${own.token}; double_drop_player=${own.token}`}}));assert.notEqual(unrelated.id,own.id);assert.equal(unrelated.fresh,true);
  const response=roomReply({},own);assert.match(response.headers.get("set-cookie")!,/double_drop_room_player=.*Path=\/; HttpOnly; SameSite=Lax/);assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.equal(roomReply({},same).headers.get("set-cookie"),null);
  assert.deepEqual(await roomActor(new Request(origin),{nickname:"  Team   Mate ",avatar:"drums"},own),{id:own.id,name:"Team Mate",avatar:"drums"});
  for(const nickname of ["", "x".repeat(21),"<b>Bad</b>","Hidden\u200dName"])await assert.rejects(roomActor(new Request(origin),{nickname},own),{code:"invalid_name"});
  await assert.rejects(roomActor(new Request(origin),{nickname:"Mate",avatar:"https://example.test/avatar.png"},own),{code:"invalid_avatar"});
});
test("commands validate turn and idempotency tokens; no cashout or forged role is accepted",()=>{
  assert.deepEqual(roomCommand({action:"guess",matchId:"match",turn:2,requestId,choice:"right"}),{action:"guess",matchId:"match",turn:2,requestId,choice:"right"});
  assert.equal(roomCommand({action:"heartbeat",matchId:"match",turn:2}).action,"heartbeat");
  for(const action of ["start","pick","bank","risk","guess","rematch"])assert.throws(()=>roomCommand({action,matchId:"match",turn:2,...(action==="guess"?{choice:"left"}:{})}),{code:"invalid_request"});
  for(const action of ["cashout","discard","next","configure"])assert.throws(()=>roomCommand({action,matchId:"match",turn:2,requestId}),{code:"invalid_move"});
  for(const turn of [-1,1.5,NaN,1_000_000_001])assert.throws(()=>roomCommand({action:"pick",matchId:"match",turn,requestId}),{code:"invalid_move"});
  assert.throws(()=>roomCommand({action:"bank",matchId:"match",turn:2,requestId,choice:"left"}),{code:"invalid_move"});
  assert.throws(()=>roomCommand({action:"ready",matchId:"match",turn:2,ready:"yes"}),{code:"invalid_move"});
});
test("room collections use existing supported metrics and derive labels from trusted catalog data",()=>{
  const tracks:CatalogTrack[]=Array.from({length:3},(_,i)=>({id:`fixture-${i}`,title:`Song ${i}`,artist:"Fixture Artist",primaryArtist:"Fixture Artist",artwork:"",sourceUrl:"https://example.test/source",metrics:{duration:{value:120+i*80,sourceUrl:"https://example.test/source"}}}));
  const sources=[{id:"fixture",url:"https://example.test/source",note:"Metadata fixture"}];const catalog:Catalog={schema:1,version:catalogVersion(tracks,sources),createdAt:"2026-11-12T00:00:00Z",tracks,sources};
  const selection=roomCreation({action:"create",requestId,theme:"artist:fixture artist",metricFilter:"duration",catalogVersion:catalog.version});
  assert.deepEqual(roomSettings(catalog,selection),{theme:"artist:fixture artist",themeLabel:"Fixture Artist",metricFilter:"duration"});
  assert.equal(roomCreation({action:"create",requestId}).theme,"all");
  assert.throws(()=>roomCreation({action:"create",requestId,metricFilter:"tempo"}),{code:"invalid_collection"});
  assert.throws(()=>roomCreation({action:"create",requestId,catalogVersion:"../../private"}),{code:"invalid_collection"});
  assert.throws(()=>roomCreation({action:"create",requestId,themeLabel:"Forged"}),{code:"invalid_body"});
  assert.throws(()=>roomSettings(catalog,{...selection,metricFilter:"streams"}),{code:"insufficient_songs"});
  const limited=roomFailure(Object.assign(new Error("Limited"),{status:429}));assert.equal(limited.status,429);assert.equal(limited.headers.get("retry-after"),"60");
});
