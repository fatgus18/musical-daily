import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTrackPool,getCatalogVersion } from "../src/lib/tracks";
import { generateDailyPuzzle } from "../src/lib/puzzle";

const index=JSON.parse(readFileSync(resolve("data/catalog-releases.json"),"utf8")) as {releases:{version:string;effectiveOn:string}[]};
test("legacy dates keep their original pool and explicit versions reject unknown files",()=>{
  const legacy=JSON.parse(readFileSync(resolve("data/catalog-releases",`${index.releases[0].version}.json`),"utf8"));
  assert.deepEqual(getTrackPool("2026-10-30"),legacy.tracks);
  assert.throws(()=>getTrackPool("2026-10-30",false,"../../secret"));
});
test("daily dates select effective releases while practice selects the newest",()=>{
  for(const release of index.releases)assert.equal(getCatalogVersion(release.effectiveOn),release.version);
  assert.equal(getCatalogVersion("2026-10-30",true),index.releases.at(-1)!.version);
});
test("published pools produce complete, reproducible boards and real optimal sums",()=>{
  for(const release of index.releases){
    for(let day=0;day<14;day++){
      const date=new Date(Date.parse("2026-11-01")+day*86400000).toISOString().slice(0,10);
      const board=generateDailyPuzzle(date,undefined,release.version);
      assert.equal(board.tracks.length,9);assert.equal(new Set(board.tracks.map(t=>t.id)).size,9);
      assert.deepEqual(board,generateDailyPuzzle(date,undefined,release.version));
      assert.ok(board.tracks.every(t=>Number.isSafeInteger(t.streams)&&t.streams>0));
      assert.ok(board.optimalSum<=board.targetStreams);
      assert.equal(board.optimalSum,board.tracks.filter(t=>board.optimalHandIds.includes(t.id)).reduce((n,t)=>n+t.streams,0));
    }
  }
});
