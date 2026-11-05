import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as finish } from "../src/app/api/finish/route";
import { POST as reveal } from "../src/app/api/reveal/route";
import { GET as daily } from "../src/app/api/daily/route";
import { GET as artwork } from "../src/app/api/artwork/route";
import { generateDailyPuzzle } from "../src/lib/puzzle";

const request = (route: string, body: unknown) => new NextRequest(`http://localhost/api/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("finish rejects duplicate, foreign, oversized and malformed hands", async () => {
  const board = generateDailyPuzzle("2026-11-01");
  for (const pickedIds of [[], [board.tracks[0].id, board.tracks[0].id], ["missing"], ["__proto__"], [3], Array(10).fill(board.tracks[0].id), null]) {
    const response = await finish(request("finish", { date: board.date, pickedIds }));
    assert.equal(response.status, 400, JSON.stringify(pickedIds));
  }
});

test("reveal and finish respect pinned exact and legacy rules", async () => {
  for (const rulesVersion of ["v2", "v3-exact"] as const) {
    const board = generateDailyPuzzle("2026-11-01", "pinned", undefined, rulesVersion);
    const identity = { date: board.date, seed: "pinned", catalogVersion: board.catalogVersion, rulesVersion };
    const revealed = await reveal(request("reveal", { ...identity, trackId: board.tracks[0].id }));
    assert.equal(revealed.status, 200);
    assert.deepEqual(await revealed.json(), { trackId: board.tracks[0].id, streams: board.tracks[0].streams });
    const response = await finish(request("finish", { ...identity, pickedIds: board.optimalHandIds }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.finalSum, board.optimalSum);
    assert.equal(result.targetStreams, board.targetStreams);
    if (rulesVersion === "v3-exact") assert.equal(result.finalSum, result.targetStreams);
  }
});

test("daily API rejects unknown rules before fetching optional media", async () => {
  const response = await daily(new NextRequest("http://localhost/api/daily?date=2026-11-01&rulesVersion=other"));
  assert.equal(response.status, 400);
});

test("artwork repair rejects unrelated tracks and returns covers without exposing answers", async () => {
  const rejected = await artwork(new NextRequest("http://localhost/api/artwork?date=2026-11-03&trackId=not-on-board"));
  assert.equal(rejected.status, 400);
  const board = generateDailyPuzzle("2026-11-03");
  const response = await artwork(new NextRequest(`http://localhost/api/artwork?date=${board.date}&trackId=${board.tracks[0].id}&catalogVersion=${board.catalogVersion}&rulesVersion=${board.rulesVersion}`));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.albumArtUrl, /^https:\/\//);
  assert.deepEqual(Object.keys(payload), ["albumArtUrl"]);
});
