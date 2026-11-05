import {test} from "node:test";
import assert from "node:assert/strict";
import {favoriteArtist,readFavorites,toggleFavorite,FAVORITES_LIMIT} from "../src/lib/favorite-artists.ts";

const artist={id:"apple:123",name:"Hozier"};
test("favorite storage accepts provider identity and display text only",()=>{
  assert.deepEqual(favoriteArtist({...artist,name:" Hozier ",url:"javascript:alert(1)",image:"https://untrusted.example/tracker",preview:"forged",tracks:[]}),artist);
  for(const value of [null,{},[],{...artist,id:"apple:0"},{...artist,id:"apple:9999999999999999"},{...artist,id:"apple:../../private"},{...artist,id:"spotify:123"},{...artist,name:"\nBad"},{...artist,name:"x".repeat(181)},{...artist,name:"  "}])assert.equal(favoriteArtist(value),null);
});

test("corrupt, oversized, and obsolete saved data fail safely and bounded lists deduplicate",()=>{
  for(const value of [null,"{bad",JSON.stringify(artist),JSON.stringify({version:2,artists:[artist]}),JSON.stringify({version:1,artists:"wrong"})," ".repeat(6001)])assert.deepEqual(readFavorites(value),[]);
  const saved=JSON.stringify({version:1,artists:[null,artist,artist,...Array.from({length:20},(_,i)=>({id:`apple:${i+200}`,name:`Artist ${i}`}))]});
  const result=readFavorites(saved);assert.equal(result.length,FAVORITES_LIMIT);assert.equal(new Set(result.map(item=>item.id)).size,FAVORITES_LIMIT);assert.deepEqual(result[0],artist);
});

test("pin and unpin preserve order, explain a full shelf, and never silently evict a favorite",()=>{
  const pinned=toggleFavorite([],artist);assert.equal(pinned.changed,true);assert.deepEqual(pinned.artists,[artist]);
  const filled=Array.from({length:8},(_,i)=>({id:`apple:${i+1}`,name:`Artist ${i}`}));
  const full=toggleFavorite(filled,artist);assert.equal(full.changed,false);assert.deepEqual(full.artists,filled);assert.match(full.message,/Unpin/);
  const removed=toggleFavorite(filled,filled[3]);assert.equal(removed.artists.length,7);assert.deepEqual(removed.artists,filled.filter((_,i)=>i!==3));
  const refilled=toggleFavorite(removed.artists,artist);assert.equal(refilled.artists.length,8);assert.deepEqual(refilled.artists.at(-1),artist);assert.equal(filled.length,8);
});
