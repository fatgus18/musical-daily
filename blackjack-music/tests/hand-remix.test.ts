import { test } from "node:test";
import assert from "node:assert/strict";
import { nearestBestHand, remixTotal } from "../src/lib/hand-remix";

test("nudges prefer the winning combination nearest to the player's own remix", () => {
  const records = [{id:"a",streams:40},{id:"b",streams:60},{id:"c",streams:30},{id:"d",streams:70}];
  assert.deepEqual(nearestBestHand(records,100,["c"]),{total:100,ids:["c","d"]});
  assert.deepEqual(nearestBestHand(records,100,["a","b"]),{total:100,ids:["a","b"]});
  assert.equal(remixTotal(records,["a","a","not-on-board"]),40);
  assert.equal(remixTotal(records,["a","b","c"]),130);
});
test("historical boards without exact fits get the best non-busting hand", () => {
  const records=[{id:"a",streams:41},{id:"b",streams:62},{id:"c",streams:32}];
  assert.deepEqual(nearestBestHand(records,100,[]),{total:94,ids:["b","c"]});
  assert.equal(nearestBestHand([{id:"a",streams:NaN}],100,[]),null);
  assert.equal(nearestBestHand(Array.from({length:13},(_,i)=>({id:String(i),streams:1})),100,[]),null);
});
