import test from "node:test";
import assert from "node:assert/strict";
import {roomArtistId,roomArtistSelection,roomBody,roomCommand,roomFailure,roomIdentity,roomReply,roomActor} from "../src/lib/rooms/http.ts";
import {CatalogError} from "../src/lib/catalog.ts";
import {allowedPreview,cleanPreview,downloadPreview,MAX_PREVIEW_BYTES} from "../src/lib/rooms/audio.ts";

const origin="https://room.example.test";
function request(body:unknown,headers:Record<string,string>={}){return new Request(`${origin}/api/rooms`,{method:"POST",headers:{origin,"content-type":"application/json",...headers},body:JSON.stringify(body)});}
test("room requests require same origin and bounded JSON, never browser supplied score or clock",async()=>{
  assert.deepEqual(await roomBody(request({action:"ready"}),origin),{action:"ready"});
  await assert.rejects(roomBody(request({}, {origin:"https://attacker.example"}),origin),/origin/);
  await assert.rejects(roomBody(request({}, {"content-type":"text/plain"}),origin),/JSON/);
  await assert.rejects(roomBody(request({huge:"x".repeat(3000)}),origin),/large/);
  await assert.rejects(roomBody(request([]),origin),/Invalid/);
  assert.throws(()=>roomCommand({action:"answer",matchId:"a",round:0,choiceId:"b",elapsedMs:1}),/unsupported/);
  assert.throws(()=>roomCommand({action:"answer",matchId:"a",round:0,choiceId:"b",score:10000}),/unsupported/);
  assert.throws(()=>roomCommand({action:"loaded",matchId:"a",round:0}),/preview/);
  assert.equal(roomCommand({action:"loaded",matchId:"a",round:0,audioRevision:2}).audioRevision,2);
});
test("room identity is a private cookie and artist IDs match the real catalog",async()=>{
  const first=roomIdentity(new Request(origin));assert.match(first.token,/^[a-f0-9]{64}$/);assert.notEqual(first.id,first.token);
  const second=roomIdentity(new Request(origin,{headers:{cookie:`encore_room_player=${first.token}`}}));assert.equal(second.id,first.id);assert.equal(second.fresh,false);
  assert.match(roomReply({},first).headers.get("set-cookie")!,/HttpOnly; SameSite=Lax/);
  assert.equal(roomReply({},second).headers.get("set-cookie"),null);
  assert.equal(roomArtistId("apple:262836961"),"apple:262836961");assert.throws(()=>roomArtistId("262836961"));assert.throws(()=>roomArtistId("http://127.0.0.1"));
  const actor=await roomActor(new Request(origin),{nickname:"  Guest   One ",avatar:"guitar"},first);assert.deepEqual(actor,{id:first.id,name:"Guest One",avatar:"guitar"});
  await assert.rejects(roomActor(new Request(origin),{nickname:"<script>"},first),/nickname/);
  await assert.rejects(roomActor(new Request(origin),{nickname:"Guest",avatar:"https://example.test/photo"},first),/avatar/);
});
test("artist selection supports legacy chosen requests and rejects contradictory or forged random settings",()=>{
  assert.deepEqual(roomArtistSelection({artistId:"apple:262836961"}),{artistMode:"chosen",artistId:"apple:262836961"});
  assert.deepEqual(roomArtistSelection({artistMode:"chosen",artistId:"apple:262836961"}),{artistMode:"chosen",artistId:"apple:262836961"});
  assert.deepEqual(roomArtistSelection({artistMode:"random"}),{artistMode:"random"});
  for(const artistMode of [null,"unknown",[],false,2])assert.throws(()=>roomArtistSelection({artistMode}),{code:"invalid_artist_mode"});
  assert.throws(()=>roomArtistSelection({artistMode:"random",artistId:"apple:262836961"}),{code:"invalid_artist_mode"});
  assert.throws(()=>roomArtistSelection({artistMode:"random",artistId:null}),{code:"invalid_artist_mode"});
  assert.throws(()=>roomArtistSelection({artistMode:"chosen"}),{code:"invalid_artist"});
  const requestId="artist-selection-test";
  assert.equal(roomCommand({action:"configure",matchId:"current",round:0,requestId,artistMode:"random"}).artistMode,"random");
  for(const action of ["ready","rematch","heartbeat"])assert.throws(()=>roomCommand({action,matchId:"current",round:0,ready:true,requestId,artistMode:"random"}),{code:"invalid_artist_mode"});
  const limited=roomFailure(new CatalogError("Music search is busy.",429,"provider_busy"));
  assert.equal(limited.status,429);assert.equal(limited.headers.get("retry-after"),"60");
});
function atom(type:string,body:Buffer){const head=Buffer.alloc(8);head.writeUInt32BE(body.length+8);head.write(type,4,4,"latin1");return Buffer.concat([head,body]);}
test("MP4 title/artist tags are removed without moving the music sample offsets",()=>{
  const audio=Buffer.from([1,2,3,4,5,6]);const source=Buffer.concat([atom("ftyp",Buffer.from("M4A \0\0\0\0")),atom("moov",atom("udta",atom("meta",Buffer.from("SECRET TITLE / SECRET ARTIST")))),atom("mdat",audio)]);
  const clean=cleanPreview(source);assert.equal(clean.type,"audio/mp4");assert.equal(clean.bytes.length,source.length);
  const result=Buffer.from(clean.bytes);assert.equal(result.includes(Buffer.from("SECRET")),false);assert.equal(result.indexOf("mdat"),source.indexOf("mdat"));assert.deepEqual(result.subarray(-audio.length),audio);
});
test("MP3 ID3 title/artist tags are removed and audio is preserved",()=>{
  const label=Buffer.from("SECRET SONG");const head=Buffer.from([73,68,51,3,0,0,0,0,0,label.length]);const frame=Buffer.from([255,251,144,100,1,2,3,4]);const tail=Buffer.alloc(128);tail.write("TAGSECRET ARTIST");
  const cleaned=cleanPreview(Buffer.concat([head,label,frame,tail]));assert.equal(cleaned.type,"audio/mpeg");assert.deepEqual(Buffer.from(cleaned.bytes),frame);
});
test("preview proxy rejects untrusted origins, redirects, non-audio and oversized bodies",async()=>{
  for(const url of ["http://audio-ssl.itunes.apple.com/x", "https://itunes.apple.com.attacker.test/x", "https://127.0.0.1/x", "https://user:pass@audio-ssl.itunes.apple.com/x", "https://audio-ssl.itunes.apple.com:8080/x"])assert.equal(allowedPreview(url),false);
  const url="https://audio-ssl.itunes.apple.com/preview.m4a";assert.equal(allowedPreview(url),true);assert.equal(allowedPreview("https://cdnt-preview.dzcdn.net/api/1.mp3"),true);
  let calls=0;await assert.rejects(downloadPreview(url,(async()=>{calls++;return new Response(null,{status:302,headers:{location:"https://127.0.0.1/private"}});}) as typeof fetch),/provider/);assert.equal(calls,1);
  await assert.rejects(downloadPreview(url,(async()=>new Response("html, not audio")) as typeof fetch),/supported audio/);
  await assert.rejects(downloadPreview(url,(async()=>new Response(new Uint8Array(3),{headers:{"content-length":String(MAX_PREVIEW_BYTES+1)}})) as typeof fetch),/couldn't load/);
  await assert.rejects(downloadPreview(url,(async()=>new Response(new Uint8Array(MAX_PREVIEW_BYTES+1))) as typeof fetch),/large/);
});
