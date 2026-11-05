import { test } from "node:test";
import assert from "node:assert/strict";
import { MUSIC_FACTS, drawMusicFact, readFactHistory } from "../src/lib/music-facts.ts";

test("facts rotate without repeats, including across a rotation boundary", () => {
  let history = [], previous;
  for (let cycle = 0; cycle < 3; cycle++) {
    const seen = new Set();
    for (let i = 0; i < MUSIC_FACTS.length; i++) {
      const next = drawMusicFact(history, () => .37);
      assert.notEqual(next.fact.id, previous);
      assert.ok(!seen.has(next.fact.id));
      seen.add(next.fact.id); previous = next.fact.id; history = next.history;
    }
    assert.equal(seen.size, MUSIC_FACTS.length);
  }
});

test("stored history is bounded and cannot inject facts or links", () => {
  const id = MUSIC_FACTS[0].id;
  assert.deepEqual(readFactHistory(JSON.stringify([id,id,"unknown",null,{id}])),[id]);
  for (const raw of [null,"not json","{}","[]", "x".repeat(5000)]) assert.deepEqual(readFactHistory(raw),[]);
  assert.equal(new Set(MUSIC_FACTS.map(fact=>fact.id)).size,MUSIC_FACTS.length);
  for (const fact of MUSIC_FACTS) {
    assert.equal(new URL(fact.musicUrl).protocol,"https:");
    assert.equal(new URL(fact.sourceUrl).protocol,"https:");
    assert.ok(fact.text.length<=190,`${fact.id} is too long for the compact card`);
  }
});
