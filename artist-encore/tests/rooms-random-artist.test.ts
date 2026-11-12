import test from "node:test";
import assert from "node:assert/strict";
import {CatalogError,type Artist,type ArtistPool,type Track} from "../src/lib/catalog.ts";
import {selectRandomArtist,RANDOM_ARTIST_ATTEMPTS,type RandomArtistDependencies} from "../src/lib/rooms/random-artist.ts";

function artist(index:number,name=`Artist ${index}`):Artist{return{id:`apple:${index}`,name,image:"",url:`https://music.apple.com/us/artist/${index}`};}
function pool(who:Artist,count=30):ArtistPool {
  const tracks:Track[]=Array.from({length:count},(_,i)=>({id:`apple:${who.id.slice(6)}${i+1000}`,title:`Song ${i}`,aliases:[],artistId:who.id,artist:who.name,preview:`https://audio-ssl.itunes.apple.com/${who.id.slice(6)}-${i}.m4a`,artwork:"",url:`https://music.apple.com/us/song/${i+1000}`,duration:180,rank:1000-i}));
  return{artist:who,tracks,ranking:{kind:"provider-rank",label:"Fixture",sourceUrl:who.url,asOf:"2026-11-12"},fetchedAt:1};
}
function dependencies(artists:Artist[]):RandomArtistDependencies {
  return{directory:async()=>({value:artists.map((a,i)=>({id:`spotify${i}`,name:a.name})),stale:false}),search:async name=>artists.filter(a=>a.name===name),load:async id=>pool(artists.find(a=>a.id===id)!),randomIndex:()=>0,now:Date.now,budgetMs:1000};
}
test("random artists come from a broad directory, not a fixed set, and cryptographic sampling can choose its tail",async()=>{
  const artists=Array.from({length:250},(_,i)=>artist(i+1));const deps=dependencies(artists);deps.randomIndex=max=>max-1;
  const selected=await selectRandomArtist({},deps);assert.equal(selected.artist.id,"apple:250");assert.equal(selected.tracks.length,30);
});
test("random rematches exclude the previous artist by either normalized name or Apple identity",async()=>{
  const artists=[artist(1,"Beyoncé"),artist(2,"New Artist")];let searches:string[]=[];const deps=dependencies(artists);
  const search=deps.search;deps.search=async name=>{searches.push(name);return search(name);};
  assert.equal((await selectRandomArtist({excludeArtistId:"apple:1",excludeArtistName:"BEYONCE"},deps)).artist.id,"apple:2");
  assert.deepEqual(searches,["New Artist"]);
  searches=[];assert.equal((await selectRandomArtist({excludeArtistId:"apple:1"},deps)).artist.id,"apple:2");assert.deepEqual(searches,["Beyoncé","New Artist"]);
});
test("ambiguous artist names and providers with fewer than ten playable recordings fall through",async()=>{
  const artists=[artist(1,"Ambiguous"),artist(2,"Unavailable"),artist(3,"Too Small"),artist(4,"Playable")];const deps=dependencies(artists);const loaded:string[]=[];
  deps.search=async name=>name==="Ambiguous"?[artist(1,name),artist(99,name)]:artists.filter(a=>a.name===name);
  deps.load=async id=>{loaded.push(id);if(id==="apple:2")throw new CatalogError("Unavailable",404,"artist_unavailable");return pool(artists.find(a=>a.id===id)!,id==="apple:3"?9:30);};
  assert.equal((await selectRandomArtist({},deps)).artist.id,"apple:4");assert.deepEqual(loaded,["apple:2","apple:3","apple:4"]);
});
test("duplicate names, wrong artist identities, foreign songs, duplicate editions and unsafe previews cannot qualify",async()=>{
  const artists=[artist(1,"Same Artist"),artist(2,"Valid Artist")];const deps=dependencies(artists);
  deps.directory=async()=>({value:[{id:"one",name:"SAME ARTIST"},{id:"two",name:"Same Artist"},{id:"three",name:"Valid Artist"}],stale:true});
  let searches=0;const search=deps.search;deps.search=async name=>{searches++;return search(name);};
  deps.load=async id=>{
    if(id==="apple:2")return pool(artists[1]);
    const malformed=pool(artists[0]);malformed.tracks=malformed.tracks.map((track,i)=>i<15?{...track,title:"Duplicate song",recordingKey:"same"}:i<22?{...track,artistId:"apple:999"}:{...track,preview:"https://attacker.test/not-a-preview"});return malformed;
  };
  assert.equal((await selectRandomArtist({},deps)).artist.id,"apple:2");assert.equal(searches,2);
  const wrongIdentity=dependencies(artists);wrongIdentity.load=async()=>pool(artist(123,"Imposter"));await assert.rejects(selectRandomArtist({},wrongIdentity),{code:"random_artist_unavailable"});
});
test("ten distinct unranked previews are eligible without manufacturing popularity tiers",async()=>{
  const artists=[artist(1)];const deps=dependencies(artists);deps.load=async()=>({...pool(artists[0],10),ranking:{kind:"unranked",label:"Discovery",sourceUrl:artists[0].url,asOf:"2026-11-12"}});
  const selected=await selectRandomArtist({},deps);assert.equal(selected.ranking.kind,"unranked");assert.equal(selected.discoveryTracks?.length,10);
});
test("provider limits stop retries and unavailable directories never fall back to fabricated artists",async()=>{
  const artists=[artist(1),artist(2)];const deps=dependencies(artists);let calls=0;deps.search=async()=>{calls++;throw new CatalogError("Busy",429,"provider_busy");};
  await assert.rejects(selectRandomArtist({},deps),{code:"provider_busy"});assert.equal(calls,1);
  deps.directory=async()=>{throw new Error("Directory failed");};await assert.rejects(selectRandomArtist({},deps),{code:"random_artist_unavailable"});assert.equal(calls,1);
});
test("candidate fallback is bounded to four and the overall selection deadline is enforced",async()=>{
  const artists=Array.from({length:20},(_,i)=>artist(i+1));const deps=dependencies(artists);let calls=0;deps.search=async()=>{calls++;return[];};
  await assert.rejects(selectRandomArtist({},deps),{code:"random_artist_unavailable"});assert.equal(calls,RANDOM_ARTIST_ATTEMPTS);
  deps.directory=()=>new Promise(()=>{});deps.budgetMs=10;
  await assert.rejects(selectRandomArtist({},deps),{code:"random_artist_unavailable"});
});
