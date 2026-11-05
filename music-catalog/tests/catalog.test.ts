import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore,trackWriter,stats,type Track } from "../src/store.ts";
import { matchRecording,recordingKey } from "../src/recordings.ts";
import { buildRotation } from "../src/rotation.ts";
import { parseStreams,flagLanguageUncertainty } from "../src/importers.ts";
import { uniqueRecordings,nextAvailableDate } from "../src/publish.ts";
import { ingest } from "../src/ingest.ts";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const track:Omit<Track,"recording_key">={id:"0VjIjW4GlUZAMYd2vXMi3b",title:"Blinding Lights",artist:"The Weeknd",primary_artist:"The Weeknd",album:"After Hours",duration_ms:200000,release_date:"2019",popularity:90,language:"en",language_source:"manual-reviewed",bpm:171,bpm_source:"review",bpm_quality:"reviewed",genre:"pop",source:"test",instrumentalness:0};
test("imports are idempotent and preserve reviewed answers and language",()=>{
  const db=openStore(":memory:");const put=trackWriter(db);
  put(track);put({...track,bpm:85,language:"es",bpm_source:"automatic",bpm_quality:"provider-estimate",language_source:"automatic"});
  const result=db.prepare("SELECT * FROM tracks").get()!;
  assert.equal(stats(db).tracks,1);assert.equal(result.bpm,171);assert.equal(result.language,"en");db.close();
});
test("recording matches reject covers, remixes, wrong artists and wrong durations",()=>{
  const hit={trackName:"Blinding Lights",artistName:"The Weeknd",trackTimeMillis:201000};
  assert.equal(matchRecording(track,hit),true);
  for(const change of [{artistName:"Tribute Band"},{trackName:"Blinding Lights (Live)"},{trackName:"Blinding Lights (Remix)"},{trackTimeMillis:230000}])assert.equal(matchRecording(track,{...hit,...change}),false);
  assert.notEqual(recordingKey("Track (Remix)","Artist"),recordingKey("Track","Artist"));
});
test("translation-prone language labels require review; recording-level approvals take precedence",()=>{
  const db=openStore(":memory:");const put=trackWriter(db);
  put({...track,genre:"k-pop",language_source:"lyrics-label",bpm_quality:"provider-estimate"});
  flagLanguageUncertainty(db);
  assert.equal(db.prepare("SELECT language_review_required FROM tracks").get()!.language_review_required,1);
  db.prepare("UPDATE tracks SET language_source='manual-reviewed'").run();
  flagLanguageUncertainty(db);
  assert.equal(db.prepare("SELECT language_review_required FROM tracks").get()!.language_review_required,0);db.close();
});
test("rotation is deterministic and does not repeat a recording within its cycle",()=>{
  const tracks=Array.from({length:503},(_,i)=>({id:String(i),artist:`Artist ${i%31}`}));
  const rounds=buildRotation(tracks,"release-a");
  assert.deepEqual(rounds,buildRotation(tracks,"release-a"));
  assert.notDeepEqual(rounds,buildRotation(tracks,"release-b"));
  const all=rounds.flat();assert.equal(new Set(all).size,all.length);assert.ok(rounds.length>=99);
  for(const round of rounds){assert.equal(round.length,5);assert.equal(new Set(round.map(id=>tracks[Number(id)].artist)).size,5);}
});
test("rotation terminates with too few distinct artists",()=>{
  assert.deepEqual(buildRotation(Array.from({length:100},(_,i)=>({id:String(i),artist:"Only artist"})),"x"),[]);
});
test("stream parser reads current header-based source and rejects invalid totals",()=>{
  const html='<table><thead><tr><th>Artist and Title</th><th>Streams</th><th>Daily</th></tr></thead><tbody><tr><td><div>Artist - Song</div></td><td>1,234,567</td><td>400</td></tr><tr><td>Bad - Track</td><td>N/A</td></tr></tbody></table>';
  assert.deepEqual(parseStreams(html),[{artist:"Artist",title:"Song",streams:1234567}]);assert.deepEqual(parseStreams("<html>blocked</html>"),[]);
});
test("release deduplication collapses album/single IDs for the same recording",()=>{
  assert.equal(uniqueRecordings([{id:"1",recording_key:"a"},{id:"2",recording_key:"a"},{id:"3",recording_key:"b"}]).length,2);
});
test("maintenance queues the next unused day without overwriting existing puzzles",()=>{
  assert.equal(nextAvailableDate("2026-11-01",["2026-11-01","2026-11-02"]),"2026-11-03");
  assert.equal(nextAvailableDate("2026-12-31",["2026-12-31"]),"2027-01-01");
});
test("invalid provider feed rolls back the whole import",async()=>{
  const db=openStore(":memory:");const dir=await mkdtemp(join(tmpdir(),"music-catalog-test-"));
  try{
    const file=join(dir,"feed.json");
    await writeFile(file,JSON.stringify([{spotifyId:track.id,title:track.title,artists:[track.artist],durationMs:200000},{spotifyId:"bad",title:"Invalid",artists:["Artist"],durationMs:10}]));
    await assert.rejects(()=>ingest(db,file,"https://example.com/feed"));assert.equal(stats(db).tracks,0);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
