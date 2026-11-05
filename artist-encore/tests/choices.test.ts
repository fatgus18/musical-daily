import {test} from "node:test";
import assert from "node:assert/strict";
import {createGame,act,publicGame,replaceClip} from "../src/lib/engine.ts";
import {ensureChoices,withChoices} from "../src/lib/choices.ts";
import {answerMatches,normalize,selectMix} from "../src/lib/rules.ts";
import type {ArtistPool,Track} from "../src/lib/catalog.ts";
const tracks:Track[]=Array.from({length:60},(_,i)=>({id:String(i),title:`Song ${i}`,artistId:"artist",artist:"Artist",aliases:[],preview:`https://audio-ssl.itunes.apple.com/${i}.m4a`,artwork:"https://is1-ssl.mzstatic.com/a.jpg",url:"https://music.apple.com/",duration:200,rank:1000-i}));
const pool:ArtistPool={artist:{id:"artist",name:"Artist",image:"",url:"https://music.apple.com/"},tracks,ranking:{kind:"streams",label:"Fixture",sourceUrl:"https://example.com",asOf:"2026-11-01"},fetchedAt:10000};
test("all rounds have four distinct real same-artist options and varied answer positions",()=>{
  const before=JSON.stringify(tracks);const positions=new Set<number>();
  for(let n=0;n<30;n++){const game=createGame("p",pool,[],`seed-${n}`);for(const pick of game.picks){assert.equal(pick.choices?.length,4);assert.equal(new Set(pick.choices!.map(c=>normalize(c.label))).size,4);assert.equal(pick.choices!.filter(c=>c.id===pick.correctChoiceId).length,1);assert.equal(pick.choices!.find(c=>c.id===pick.correctChoiceId)!.label,pick.track.title);assert.ok(pick.choices!.every(c=>tracks.some(t=>t.title===c.label)));positions.add(pick.choices!.findIndex(c=>c.id===pick.correctChoiceId));}}
  assert.equal(positions.size,4);assert.equal(JSON.stringify(tracks),before);
  const selected=new Set<string>();for(let i=0;i<300;i++)selectMix(tracks,[],String(i)).forEach(p=>selected.add(p.track.id));assert.equal(selected.size,tracks.length);
});
test("correct aliases, title variants, and wrong-artist titles cannot be misleading distractors",()=>{
  const correct={...tracks[0],title:"Song (Bonus Track)",aliases:["Song"]};
  const variants=[correct,{...tracks[1],title:"Song",aliases:[]},{...tracks[2],title:"Other variant",aliases:["Song (Bonus Track)"]},{...tracks[3],artistId:"other",artist:"Other artist",title:"Foreign"},...tracks.slice(4)];
  const pick=withChoices({track:correct,tier:"hit"},variants,"variants");
  assert.ok(pick.choices!.filter(c=>c.id!==pick.correctChoiceId).every(c=>!answerMatches(correct,c.label)&&c.label!=="Other variant"&&c.label!=="Foreign"));
});
test("public game and round seeds do not determine the correct answer position",()=>{
  const positions=new Set<number>();for(let i=0;i<40;i++){const pick=withChoices({track:tracks[0],tier:"hit"},tracks,"same-public-game:0");positions.add(pick.choices!.findIndex(c=>c.id===pick.correctChoiceId));}assert.equal(positions.size,4);
});
test("choices appear only for the active guess, and the correct ID remains private",()=>{
  const game=createGame("p",pool,[],"privacy",10000);assert.equal(publicGame(game).choices,undefined);act(game,"listen",0,"",10000);assert.equal(publicGame(game).choices,undefined);act(game,"heard",0,"",20000);
  const state=publicGame(game,21000);assert.equal(state.choices?.length,4);assert.equal(JSON.stringify(state).includes("correctChoiceId"),false);assert.equal(JSON.stringify(state).includes(game.picks[1].choices![0].id),false);
  const clone=structuredClone(game);ensureChoices(clone);assert.deepEqual(publicGame(clone,21000).choices,state.choices);
});
test("foreign choice IDs and typed titles cannot score; selected wrong answers score once",()=>{
  const game=createGame("p",pool,[],"validation",10000);act(game,"listen",0,"",10000);act(game,"heard",0,"",20000);const deadline=game.guessDeadline;
  for(const invalid of ["forged",game.picks[1].correctChoiceId!,game.picks[0].track.title])assert.throws(()=>act(game,"answer",0,invalid,21000),/four/);
  assert.equal(game.results.length,0);assert.equal(game.guessDeadline,deadline);
  const wrong=game.picks[0].choices!.find(c=>c.id!==game.picks[0].correctChoiceId)!;act(game,"answer",0,wrong.id,22000);assert.equal(game.results[0].correct,false);assert.equal(game.results[0].input,wrong.label);act(game,"answer",0,game.picks[0].correctChoiceId!,23000);assert.equal(game.results.length,1);
});
test("saved-game migration preserves recordings, results and deadlines",()=>{
  const game=createGame("p",pool,[],"legacy",10000);act(game,"listen",0,"",10000);act(game,"heard",0,"",20000);for(const pick of game.picks){delete pick.choices;delete pick.correctChoiceId;}const titles=game.picks.map(p=>p.track.id);const deadline=game.guessDeadline;
  assert.equal(ensureChoices(game),true);const choices=JSON.stringify(game.picks.map(p=>p.choices));assert.equal(ensureChoices(game),false);assert.equal(JSON.stringify(game.picks.map(p=>p.choices)),choices);assert.deepEqual(game.picks.map(p=>p.track.id),titles);assert.equal(game.guessDeadline,deadline);assert.equal(game.results.length,0);
});
test("clip replacements get matching new options without changing other rounds",()=>{
  const game=createGame("p",pool,[],"replace",10000);const old=game.picks[0].correctChoiceId;const other=JSON.stringify(game.picks.slice(1));replaceClip(game,pool,[]);assert.notEqual(game.picks[0].correctChoiceId,old);assert.equal(game.picks[0].choices!.find(c=>c.id===game.picks[0].correctChoiceId)!.label,game.picks[0].track.title);assert.equal(JSON.stringify(game.picks.slice(1)),other);
});
