import test from "node:test";
import assert from "node:assert/strict";
import {createGame,act,publicGame,settleClock,migrateRetiredMetric} from "../src/lib/engine.ts";
import {availableMetrics,drawPair,eligiblePair,findEligiblePair,GUESS_DURATION_MS,MAX_COMPARISONS,MAX_LADDER,pairKey,winner} from "../src/lib/rules.ts";
import {openStore,transaction,findGame,findRequest,historyFor,saveGame,settleSavedGame,rateLimit,pruneStore} from "../src/lib/store.ts";
import {claimGuestGames,flushAccountResults,queueAccountResult} from "../src/lib/account-results.ts";
import type {Catalog,CatalogTrack,Metric} from "../src/lib/catalog.ts";
import {loadCatalog} from "../src/lib/catalog.ts";
import type {Game,Move,Side} from "../src/lib/types.ts";
import {initializeRecords,personalBest,recordFinishedBank} from "../src/lib/records.ts";
import {goalProgress,runMilestone} from "../src/lib/run-goals.ts";

function fixture():Catalog {
  const tracks=Array.from({length:100},(_,i):CatalogTrack=>({id:`song-${i}`,title:`Song ${i}`,artist:`Artist ${i%8}`,primaryArtist:`Artist ${i%8}`,artwork:"https://example.com/art.jpg",sourceUrl:"https://example.com/catalog",popularity:50+i%50,genre:i%2?"pop":"rock",metrics:{streams:{value:10_000_000*(i+1),sourceUrl:"https://example.com/streams",asOf:"2026-11-01"},duration:{value:100+i*3,sourceUrl:"https://example.com/duration"},tempo:{value:60+i,sourceUrl:"https://example.com/tempo",quality:"provider-estimate"}}}));
  return {schema:1,version:"0123456789abcdef",createdAt:"2026-11-01T00:00:00.000Z",tracks,sources:[{id:"test",url:"https://example.com",note:"Test fixture only"}]};
}
const catalog=fixture();
function fresh(player="guest",theme="all"){return createGame(player,catalog,crypto.randomUUID(),{theme},1_000_000);}
function move(game:Game,action:Move,choice?:Side){return act(game,action,game.round,game.revision,choice,catalog,game.updatedAt+1);}
function correct(game:Game){return move(game,"guess",winner(game.pair));}
function wrong(game:Game){return move(game,"guess",winner(game.pair)==="left"?"right":"left");}

test("bank targets are opt-in, whitelisted and driven by protected bank only",()=>{
  const game=createGame("guest",catalog,crypto.randomUUID(),{bankTarget:500,bestBankToBeat:400},1_000_000);
  assert.equal(publicGame(game).bankTarget,500);assert.equal(publicGame(game).bestBankToBeat,400);
  for(let i=0;i<4;i++){correct(game);if(i<3)move(game,"risk");}
  assert.equal(game.pot,800);assert.deepEqual(goalProgress(publicGame(game)),{target:500,reached:false,remaining:500,percent:0});
  const before=publicGame(game);move(game,"bank");
  assert.equal(game.phase,"guess");assert.equal(game.lives,3);assert.equal(game.guessDeadline,game.updatedAt+GUESS_DURATION_MS);
  assert.deepEqual(goalProgress(publicGame(game)),{target:500,reached:true,remaining:0,percent:100});
  assert.match(runMilestone(before,publicGame(game))!,/Goal in the bank/);
  assert.equal(runMilestone(null,publicGame(game)),null);assert.equal(runMilestone(publicGame(game),publicGame(game)),null);
  assert.equal(goalProgress(publicGame(fresh())),null);
  for(const value of ["500",true,[],{},0,-1,500.5,999,NaN,Infinity])assert.throws(()=>createGame("guest",catalog,crypto.randomUUID(),{bankTarget:value as 500}),/available bank targets/);
});

test("streak milestones use new correct answers and records use banks, not an at-risk pot",()=>{
  const game=createGame("guest",catalog,crypto.randomUUID(),{bestBankToBeat:100},1_000_000);
  correct(game);move(game,"risk");correct(game);move(game,"risk");
  const before=publicGame(game);correct(game);assert.match(runMilestone(before,publicGame(game))!,/3 correct in a row/);
  const withPot=publicGame(game);move(game,"bank");assert.match(runMilestone(withPot,publicGame(game))!,/personal best/);
  const afterBank=publicGame(game);correct(game);assert.equal(runMilestone(afterBank,publicGame(game)),null);
  move(game,"risk");wrong(game);assert.equal(game.currentStreak,0);assert.equal(game.bestStreak,4);
});

test("personal best persists after history pruning and stays isolated per player",()=>{
  const db=openStore(":memory:");try{
    const game=fresh("guest:record");saveGame(db,game);
    correct(game);move(game,"risk");correct(game);move(game,"bank");saveGame(db,game,0);
    assert.equal(personalBest(db,game.player),null);
    const revision=game.revision;move(game,"discard");saveGame(db,game,revision);
    assert.equal(personalBest(db,game.player),200);assert.equal(personalBest(db,"guest:other"),null);
    pruneStore(db,game.updatedAt+100*86400000,true);assert.equal(findGame(db,game.player),null);assert.equal(personalBest(db,game.player),200);
    const less=fresh(game.player);correct(less);move(less,"cashout");saveGame(db,less);assert.equal(personalBest(db,game.player),200);
    recordFinishedBank(db,{...less,banked:Infinity});assert.equal(personalBest(db,game.player),200);
    recordFinishedBank(db,{...less,banked:100000,answered:0});assert.equal(personalBest(db,game.player),200);
  }finally{db.close();}
});

test("record migration backfills finalized saved runs once and verified claims merge maximum banks",()=>{
  const db=openStore(":memory:");try{
    const guest=fresh("guest:historical");correct(guest);move(guest,"cashout");saveGame(db,guest);
    const account=fresh("account:record-owner");correct(account);move(account,"risk");correct(account);move(account,"cashout");saveGame(db,account);
    db.exec("DELETE FROM personal_records;DELETE FROM maintenance WHERE key='personal-records-v1'");initializeRecords(db);
    assert.equal(personalBest(db,guest.player),100);assert.equal(personalBest(db,account.player),200);
    transaction(db,()=>claimGuestGames(db,guest.player,"record-owner",guest.updatedAt+1));
    assert.equal(personalBest(db,guest.player),null);assert.equal(personalBest(db,account.player),200);
    transaction(db,()=>claimGuestGames(db,guest.player,"record-owner",guest.updatedAt+2));assert.equal(personalBest(db,account.player),200);
    const larger=fresh("guest:pruned");for(let i=0;i<3;i++){correct(larger);if(i<2)move(larger,"risk");}move(larger,"cashout");saveGame(db,larger);
    db.prepare("DELETE FROM games WHERE player=?").run(larger.player);
    transaction(db,()=>claimGuestGames(db,larger.player,"record-owner",larger.updatedAt+1));assert.equal(personalBest(db,account.player),400);
  }finally{db.close();}
});

test("new run hides both values, winners and source URLs before a guess",()=>{
  const state=publicGame(fresh());assert.equal(state.phase,"guess");assert.equal(state.lives,3);assert.equal(state.nextReward,100);assert.equal(state.reveal,undefined);assert.equal(state.results.length,0);
  const serialized=JSON.stringify(state.pair);assert.ok(!serialized.includes("metrics"));assert.ok(!serialized.includes("sourceUrl"));assert.ok(!serialized.includes("value"));assert.ok(!serialized.includes("winner"));
});

test("tempo cannot be selected explicitly or reappear in mixed comparisons, even with preview metadata",()=>{
  const tracks=catalog.tracks.map(track=>({...track,previewUrl:"https://audio-ssl.itunes.apple.com/example.m4a",previewSourceUrl:"https://music.apple.com/example"}));
  assert.deepEqual(availableMetrics(tracks,"tempo"),[]);
  assert.throws(()=>createGame("guest",{...catalog,tracks},crypto.randomUUID(),{metricFilter:"tempo"}),/valid collection/);
  for(let i=0;i<30;i++)assert.notEqual(drawPair(tracks,{seed:`no-tempo-${i}`,filter:"mixed",round:i,ladder:i%6,recentTracks:[],recentPairs:[]}).metric,"tempo");
});

test("non-tempo pair payloads never expose audio or provider playback links, including after a reveal",()=>{
  for(const metricFilter of ["duration","streams"] as const){
    const game=createGame("guest",catalog,crypto.randomUUID(),{metricFilter},1_000_000);
    for(const side of ["left","right"] as const){game.pair[side]={...game.pair[side],previewUrl:"https://audio-ssl.itunes.apple.com/example.m4a",previewSourceUrl:"https://music.apple.com/example"};}
    for(const revealed of [false,true]){
      if(revealed)correct(game);
      for(const track of [publicGame(game).pair.left,publicGame(game).pair.right]){assert.equal(track.previewUrl,undefined);assert.equal(track.previewSourceUrl,undefined);}
    }
  }
});

test("legacy tempo playback links stay hidden until the question is answered",()=>{
  const game=fresh();game.pair.metric="tempo";
  game.pair.left={...game.pair.left,previewUrl:"https://audio-ssl.itunes.apple.com/example.m4a",previewSourceUrl:"https://music.apple.com/example"};
  assert.ok(publicGame(game).pair.left.previewUrl);assert.equal(publicGame(game).pair.left.previewSourceUrl,undefined);
  correct(game);assert.equal(publicGame(game).pair.left.previewSourceUrl,"https://music.apple.com/example");
});

test("retiring a pending tempo pick preserves earned state, replaces the timer and invalidates old answers",()=>{
  const game=fresh();correct(game);move(game,"bank");correct(game);move(game,"risk");game.pair.metric="tempo";game.metricFilter="tempo";
  const prior=structuredClone(game),now=game.guessDeadline!+60_000;
  assert.equal(migrateRetiredMetric(game,catalog,()=>{throw new Error("unneeded fallback");},now),true);
  assert.equal(game.metricFilter,"mixed");assert.notEqual(game.pair.metric,"tempo");assert.equal(game.guessDeadline,now+GUESS_DURATION_MS);assert.equal(game.revision,prior.revision+1);
  for(const key of ["id","round","banked","pot","lives","ladder","correct","answered","bestStreak","currentStreak","createdAt"] as const)assert.deepEqual(game[key],prior[key],key);
  assert.deepEqual(game.results,prior.results);assert.match(game.modeNotice!,/points and lives are unchanged/);
  assert.equal(act(game,"guess",prior.round,prior.revision,"left",undefined,now+1).stale,true);
  assert.equal(migrateRetiredMetric(game,catalog,()=>catalog,now+2),false);assert.equal(settleClock(game,now+2),false);
});

test("an answered legacy tempo round retains its reveal and can bank into an allowed next comparison",()=>{
  const game=fresh();game.pair.metric="tempo";game.metricFilter="tempo";correct(game);
  const prior=structuredClone(game);
  assert.equal(migrateRetiredMetric(game,catalog,()=>catalog,game.updatedAt+1),true);
  assert.deepEqual(game.pair,prior.pair);assert.deepEqual(game.results,prior.results);assert.equal(game.pot,prior.pot);
  move(game,"bank");assert.equal(game.banked,100);assert.notEqual(game.pair.metric,"tempo");
});

test("unplayable pinned tempo collections fall back locally without losing the pot and failure is atomic",()=>{
  const game=fresh();game.metricFilter="tempo";game.pair.metric="tempo";game.theme="jazz";game.banked=500;game.pot=200;game.ladder=2;
  const retired={...catalog,tracks:catalog.tracks.map(track=>({...track,genre:"jazz",metrics:{tempo:track.metrics.tempo}}))};
  const before=structuredClone(game);
  assert.throws(()=>migrateRetiredMetric(game,retired,()=>{throw new Error("collection offline");},game.updatedAt+1),/collection offline/);assert.deepEqual(game,before);
  const replacement={...catalog,version:"fedcba9876543210"};
  migrateRetiredMetric(game,retired,()=>replacement,game.updatedAt+1);
  assert.equal(game.catalogVersion,replacement.version);assert.equal(game.theme,"all");assert.equal(game.banked,500);assert.equal(game.pot,200);assert.equal(game.ladder,2);assert.equal(game.lives,3);assert.match(game.modeNotice!,/full collection/);
});

test("stored legacy tempo migration persists once before expiry and survives reload and account handoff",()=>{
  const db=openStore(":memory:");try{
    const actual=loadCatalog();const game=createGame("guest:migration",actual,crypto.randomUUID(),{},1_000_000);
    game.pair=findEligiblePair(actual.tracks,"tempo")!;game.metricFilter="tempo";saveGame(db,game);
    const now=game.guessDeadline!+60_000;
    const changed=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),now))!;
    assert.equal(changed.lives,3);assert.equal(changed.answered,0);assert.equal(changed.revision,1);assert.equal(changed.guessDeadline,now+GUESS_DURATION_MS);assert.notEqual(changed.pair.metric,"tempo");
    const reloaded=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),now+1000))!;assert.equal(reloaded.guessDeadline,changed.guessDeadline);assert.equal(reloaded.revision,1);
    const other=createGame("guest:claim-migration",actual,crypto.randomUUID(),{},1_000_000);other.pair=findEligiblePair(actual.tracks,"tempo")!;other.metricFilter="tempo";saveGame(db,other);
    transaction(db,()=>claimGuestGames(db,other.player,"migration-owner",now));
    const claimed=findGame(db,"account:migration-owner")!;assert.equal(claimed.lives,3);assert.equal(claimed.answered,0);assert.equal(claimed.guessDeadline,now+GUESS_DURATION_MS);assert.notEqual(claimed.pair.metric,"tempo");
  }finally{db.close();}
});
test("correct decisions double a pot, bank protects it, and an error only loses unbanked points",()=>{
  const game=fresh();correct(game);assert.equal(game.pot,100);move(game,"risk");correct(game);assert.equal(game.pot,200);move(game,"bank");assert.equal(game.banked,200);assert.equal(game.pot,0);assert.equal(game.phase,"guess");correct(game);move(game,"risk");wrong(game);assert.equal(game.banked,200);assert.equal(game.pot,0);assert.equal(game.lives,2);assert.equal(game.phase,"miss");assert.equal(game.correct,3);assert.equal(game.answered,4);
});
test("risking is binding: no bank or cashout after seeing the next pair",()=>{
  const game=fresh();correct(game);move(game,"risk");const before=structuredClone(game);
  assert.throws(()=>move(game,"bank"),/before banking/);assert.throws(()=>move(game,"cashout"),/Finish this comparison/);assert.deepEqual(game,before);
});
test("a six-win ladder must bank at 3200 and can continue on a fresh ladder",()=>{
  const game=fresh();for(let i=0;i<MAX_LADDER;i++){correct(game);if(i<MAX_LADDER-1)move(game,"risk");}
  assert.equal(game.pot,3200);assert.equal(publicGame(game).canRisk,false);assert.equal(publicGame(game).nextReward,0);assert.throws(()=>move(game,"risk"),/Bank this ladder/);move(game,"bank");assert.equal(game.banked,3200);assert.equal(game.ladder,0);correct(game);assert.equal(game.pot,100);
});
test("three misses finish once and count the final answer",()=>{
  const game=fresh();for(let i=0;i<3;i++){wrong(game);if(i<2)move(game,"next");}
  assert.equal(game.phase,"complete");assert.equal(game.answered,3);assert.equal(game.lives,0);const revision=game.revision;assert.equal(move(game,"cashout").stale,true);assert.equal(game.revision,revision);
});
test("cashout from a decision protects the whole earned pot",()=>{
  const game=fresh();correct(game);move(game,"cashout");assert.equal(game.phase,"complete");assert.equal(game.banked,100);assert.equal(game.pot,0);assert.equal(game.endReason,"cashout");
});
test("extreme run bounds settle earned points before reaching account validator limits",()=>{
  const game=fresh();game.answered=MAX_COMPARISONS-1;game.correct=MAX_COMPARISONS-1;correct(game);
  assert.equal(game.phase,"complete");assert.equal(game.endReason,"run-limit");assert.equal(game.answered,MAX_COMPARISONS);assert.equal(game.correct,MAX_COMPARISONS);assert.equal(game.banked,100);assert.equal(game.pot,0);
  const miss=fresh();miss.answered=MAX_COMPARISONS-1;wrong(miss);assert.equal(miss.phase,"complete");assert.equal(miss.banked,0);assert.equal(miss.answered,MAX_COMPARISONS);
});
test("a stale answer/decision never awards points twice or advances twice",()=>{
  const game=fresh(),round=game.round,revision=game.revision;const choice=winner(game.pair);correct(game);
  assert.equal(act(game,"guess",round,revision,choice,catalog).stale,true);assert.equal(game.pot,100);assert.equal(game.correct,1);
  const decisionRevision=game.revision;move(game,"bank");assert.equal(act(game,"bank",round,decisionRevision,undefined,catalog).stale,true);assert.equal(game.banked,100);assert.equal(game.round,1);
});
test("failure to load the pinned catalog cannot lose a decision's earned points",()=>{
  const game=fresh();correct(game);const before=structuredClone(game);
  assert.throws(()=>act(game,"bank",game.round,game.revision,undefined,undefined),/couldn't load/);assert.deepEqual(game,before);
  assert.throws(()=>act(game,"bank",game.round,game.revision,undefined,{...catalog,version:"fedcba9876543210"}),/temporarily unavailable/);assert.deepEqual(game,before);
});
test("unsupported collections, filters and tiny pools fail before creating a run",()=>{
  assert.throws(()=>fresh("guest","missing"),/more comparable/);assert.throws(()=>createGame("g",catalog,"request-request",{metricFilter:"invalid" as Metric}),/valid collection/);assert.throws(()=>createGame("g",{...catalog,tracks:catalog.tracks.slice(0,1)},"request-request"),/more comparable/);
});
test("small artists remain playable with two fair recordings",()=>{
  const tiny={...catalog,tracks:catalog.tracks.slice(0,2)};
  const game=createGame("guest",tiny,"request-request",{},1_000_000);
  assert.equal(eligiblePair(game.pair.left,game.pair.right,game.pair.metric),true);
});
test("pair rules reject same recordings, displayed ties and mismatched stream snapshots",()=>{
  const a=structuredClone(catalog.tracks[0]),b=structuredClone(catalog.tracks[1]);assert.equal(eligiblePair(a,a,"tempo"),false);
  b.artist=a.artist;b.title=a.title+" - Remastered";assert.equal(eligiblePair(a,b,"tempo"),false);
  b.title="Different";b.metrics.tempo!.value=a.metrics.tempo!.value+.1;assert.equal(eligiblePair(a,b,"tempo"),false);
  b.metrics.streams!.asOf="2026-10-31";assert.equal(eligiblePair(a,b,"streams"),false);
  const c=structuredClone(catalog.tracks[2]);c.metrics.streams!.asOf="2026-10-31";assert.deepEqual(availableMetrics([a,b,c],"streams"),["streams"]);
});
test("draws are seeded, avoid recent tracks where possible, and compare valid metrics",()=>{
  const settings={seed:"known-seed",filter:"mixed" as const,round:8,ladder:2,recentTracks:catalog.tracks.slice(0,40).map(track=>track.id),recentPairs:[]};
  const a=drawPair(catalog.tracks,settings);assert.deepEqual(a,drawPair(catalog.tracks,settings));assert.ok(!settings.recentTracks.includes(a.left.id));assert.ok(!settings.recentTracks.includes(a.right.id));assert.ok(eligiblePair(a.left,a.right,a.metric));
});
test("small artist pools fall back fairly without hanging when recent history fills the pool",()=>{
  const tracks=catalog.tracks.slice(0,12),recentTracks=tracks.map(track=>track.id);const pair=drawPair(tracks,{seed:"small",filter:"duration",round:200,ladder:4,recentTracks,recentPairs:[]});assert.ok(eligiblePair(pair.left,pair.right,pair.metric));
});
test("full-pool fallback finds fair comparisons even when the random sample only contains ties",()=>{
  const tracks=Array.from({length:1000},(_,i):CatalogTrack=>({...catalog.tracks[0],id:`skew-${i}`,title:`Skew song ${i}`,artist:`Skew artist ${i}`,popularity:75,metrics:{duration:{value:i<990?180:190+i%10,sourceUrl:"https://example.com/duration"}}}));
  assert.deepEqual(availableMetrics(tracks),["duration"]);
  for(let i=0;i<10;i++){
    const options={seed:`sample-case-${i}`,filter:"duration" as const,round:0,ladder:0,recentTracks:[],recentPairs:[]};
    const pair=drawPair(tracks,options);assert.ok(eligiblePair(pair.left,pair.right,pair.metric));assert.deepEqual(pair,drawPair(tracks,options));
  }
});
test("availability keeps a second distinct-value representative when one title has multiple versions",()=>{
  const a=structuredClone(catalog.tracks[0]),b=structuredClone(a),c=structuredClone(catalog.tracks[1]);
  b.id="alternate";b.title=`${a.title} - Remastered`;b.metrics.duration!.value=a.metrics.duration!.value+10;c.metrics.duration!.value=a.metrics.duration!.value;
  assert.equal(eligiblePair(a,b,"duration"),false);assert.equal(eligiblePair(a,c,"duration"),false);assert.equal(eligiblePair(b,c,"duration"),true);assert.deepEqual(availableMetrics([a,b,c],"duration"),["duration"]);
});
test("higher stakes narrow comparison gaps without changing the source values",()=>{
  let easy=0,hard=0;
  for(let i=0;i<60;i++){const options={seed:`difficulty-${i}`,filter:"duration" as const,round:5,recentTracks:[],recentPairs:[]};for(const [ladder,isHard] of [[0,false],[5,true]] as const){const pair=drawPair(catalog.tracks,{...options,ladder});const a=pair.left.metrics.duration!.value,b=pair.right.metrics.duration!.value;const gap=Math.abs(a-b)/Math.max(a,b);if(isHard)hard+=gap;else easy+=gap;}}
  assert.ok(easy>hard*1.8,`${easy} should be materially easier than ${hard}`);
});
test("long runs retain bounded reveal/history data and never repeat the immediate pair",()=>{
  const game=fresh();for(let i=0;i<100;i++){const previous=pairKey(game.pair);correct(game);move(game,"bank");assert.notEqual(pairKey(game.pair),previous);}
  assert.equal(game.banked,10000);assert.equal(game.answered,100);assert.equal(game.results.length,20);assert.ok(game.recentTracks.length<=40);assert.ok(game.recentPairs.length<=40);assert.equal(game.phase,"guess");
});
test("starting another run carries bounded recent history and avoids the previous songs",()=>{
  const db=openStore(":memory:");try{
    const previous=fresh();for(let i=0;i<8;i++){correct(previous);move(previous,"bank");}move(previous,"cashout");saveGame(db,previous);
    const history=historyFor(db,"guest");assert.ok(history.recentTracks.includes(previous.pair.left.id));assert.ok(history.recentPairs.includes(pairKey(previous.pair)));
    const next=createGame("guest",catalog,crypto.randomUUID(),{},previous.updatedAt+1,history);
    assert.ok(!history.recentTracks.includes(next.pair.left.id));assert.ok(!history.recentTracks.includes(next.pair.right.id));assert.notEqual(pairKey(next.pair),pairKey(previous.pair));assert.ok(next.recentTracks.length<=40);assert.ok(next.recentPairs.length<=40);assert.deepEqual(historyFor(db,"other"),{recentTracks:[],recentPairs:[]});
  }finally{db.close();}
});
test("store isolates ownership, enforces a single active run and prevents stale CAS writes",()=>{
  const db=openStore(":memory:");try{const game=fresh();transaction(db,()=>saveGame(db,game));assert.equal(findGame(db,"other",game.id),null);assert.equal(findRequest(db,"guest",game.requestId)?.id,game.id);assert.throws(()=>transaction(db,()=>saveGame(db,fresh())),/UNIQUE/);
    const old=structuredClone(game);correct(game);transaction(db,()=>saveGame(db,game,0));correct(old);assert.throws(()=>transaction(db,()=>saveGame(db,old,0)),/changed in another tab/);assert.equal(findGame(db,"guest")?.correct,1);
  }finally{db.close();}
});
test("a completed account run queues exactly one trusted accuracy and banked-points result",()=>{
  const db=openStore(":memory:");try{const game=fresh("account:one");saveGame(db,game);correct(game);move(game,"cashout");saveGame(db,game,0);queueAccountResult(db,game);
    const rows=db.prepare("SELECT event FROM account_result_outbox").all();assert.equal(rows.length,1);const event=JSON.parse(String(rows[0].event));assert.equal(event.score,1);assert.equal(event.maxScore,1);assert.equal(event.bankedPoints,100);assert.equal(event.won,true);
  }finally{db.close();}
});
test("zero-attempt quits record incomplete runs without manufacturing score or accuracy",()=>{
  const db=openStore(":memory:");try{
    const game=fresh("account:one");saveGame(db,game);move(game,"cashout");saveGame(db,game,0);
    const event=JSON.parse(String(db.prepare("SELECT event FROM account_result_outbox").get()!.event));
    assert.equal(game.completionStatus,"incomplete");assert.equal(game.endReason,"discarded");
    assert.deepEqual(event,{eventId:game.id,mode:"practice",date:"1970-01-01",status:"incomplete",incompleteReason:"discarded",score:0,maxScore:0,won:false,correct:0,rounds:0,bankedPoints:0});
  }finally{db.close();}
});
test("banked points survive a loss ending and remain a banked run in account stats",()=>{
  const db=openStore(":memory:");try{const game=fresh("account:one");correct(game);move(game,"bank");for(let i=0;i<3;i++){wrong(game);if(i<2)move(game,"next");}saveGame(db,game);assert.equal(game.endReason,"lives");assert.equal(game.banked,100);const row=db.prepare("SELECT event FROM account_result_outbox").get()!;const event=JSON.parse(String(row.event));assert.deepEqual({score:event.score,maxScore:event.maxScore,bankedPoints:event.bankedPoints,won:event.won},{score:1,maxScore:4,bankedPoints:100,won:true});}finally{db.close();}
});
test("guest claims keep the existing account run and discard a guest decision once without banking",()=>{
  const db=openStore(":memory:");try{const account=fresh("account:one"),guest=fresh("guest");correct(guest);saveGame(db,account);saveGame(db,guest);assert.equal(transaction(db,()=>claimGuestGames(db,"guest","one")),1);assert.equal(findGame(db,"account:one")?.id,account.id);assert.equal(findGame(db,"guest"),null);const claimed=findGame(db,"account:one",guest.id)!;assert.equal(claimed.phase,"complete");assert.equal(claimed.banked,0);assert.equal(claimed.pot,0);assert.equal(claimed.completionStatus,"incomplete");assert.equal(claimed.endReason,"account-merge");assert.equal(transaction(db,()=>claimGuestGames(db,"guest","one")),0);
    const events=db.prepare("SELECT event FROM account_result_outbox").all().map(row=>JSON.parse(String(row.event)));
    assert.equal(events.length,1);assert.equal(events[0].status,"incomplete");assert.equal(events[0].incompleteReason,"account-merge");assert.equal(events[0].won,false);
  }finally{db.close();}
});
test("a failed account publish stays durable and a later success clears the outbox",async()=>{
  const db=openStore(":memory:");try{const game=fresh("account:one");correct(game);move(game,"cashout");saveGame(db,game);
    assert.equal(await flushAccountResults(db,game.player,async()=>{throw new Error("offline");},10000),false);
    let count=0;assert.equal(await flushAccountResults(db,game.player,async events=>{count=events.length;return {saved:true};},16000),true);assert.equal(count,1);
  }finally{db.close();}
});
test("concurrent result flushes share a retry lease and never require duplicate publication",async()=>{
  const db=openStore(":memory:");try{
    const game=fresh("account:one");correct(game);move(game,"cashout");saveGame(db,game);
    let release!:(value:{saved:boolean})=>void;let published=0;
    const pending=new Promise<{saved:boolean}>(resolve=>{release=resolve;});
    const first=flushAccountResults(db,game.player,async()=>{published++;return pending;},10000);
    const second=await flushAccountResults(db,game.player,async()=>{published++;return {saved:true};},10001);
    assert.equal(second,false);assert.equal(published,1);release({saved:true});assert.equal(await first,true);
  }finally{db.close();}
});
test("retention expires an abandoned risk without banking it, and request limits reset",()=>{
  const db=openStore(":memory:");try{const game=fresh("account:one");correct(game);move(game,"risk");saveGame(db,game);pruneStore(db,game.updatedAt+31*86400000,true);const saved=findGame(db,game.player)!;assert.equal(saved.phase,"complete");assert.equal(saved.endReason,"expired");assert.equal(saved.banked,0);assert.equal(saved.pot,0);
    rateLimit(db,"guest","test",1,60000,1000);assert.throws(()=>rateLimit(db,"guest","test",1,60000,1001),/too many/);rateLimit(db,"guest","test",1,60000,61001);
  }finally{db.close();}
});

test("picks have exactly twenty seconds and the final millisecond still accepts a correct answer",()=>{
  const game=fresh(),deadline=game.createdAt+GUESS_DURATION_MS;
  assert.equal(game.guessDeadline,deadline);assert.equal(publicGame(game,deadline-1).guessDeadline,deadline);
  const result=act(game,"guess",game.round,game.revision,winner(game.pair),undefined,deadline-1);
  assert.equal(result.stale,false);assert.equal(game.correct,1);assert.equal(game.phase,"decision");
  assert.equal(game.guessDeadline,null);assert.equal(result.game.guessDeadline,null);assert.equal(result.game.reveal?.timedOut,false);
  assert.equal(settleClock(game,deadline+100_000),false);assert.equal(game.lives,3);
});
test("a guess arriving exactly at its deadline times out without awarding points",()=>{
  const game=fresh(),deadline=game.guessDeadline!;
  const result=act(game,"guess",game.round,game.revision,winner(game.pair),undefined,deadline);
  assert.equal(result.stale,true);assert.equal(game.phase,"miss");assert.equal(game.lives,2);assert.equal(game.answered,1);assert.equal(game.correct,0);
  assert.equal(result.game.reveal?.selected,null);assert.equal(result.game.reveal?.timedOut,true);assert.equal(result.game.guessDeadline,null);
  assert.equal(settleClock(game,deadline+1_000_000),false);assert.equal(game.answered,1);
});
test("early timeout requests neither consume revisions nor reduce the available window",()=>{
  const game=fresh(),before=structuredClone(game),deadline=game.guessDeadline!;
  const early=act(game,"timeout",game.round,game.revision,undefined,undefined,deadline-1);
  assert.equal(early.stale,true);assert.deepEqual(game,before);
  const expired=act(game,"timeout",game.round,game.revision,undefined,undefined,deadline);
  assert.equal(expired.game.lives,2);assert.equal(expired.game.reveal?.timedOut,true);
});
test("banking, risking and continuing after a miss each start a new twenty-second pick",()=>{
  const game=fresh();correct(game);
  const riskAt=game.updatedAt+90_000;
  act(game,"risk",game.round,game.revision,undefined,catalog,riskAt);
  assert.equal(game.guessDeadline,riskAt+GUESS_DURATION_MS);correct(game);
  const bankAt=game.updatedAt+120_000;
  act(game,"bank",game.round,game.revision,undefined,catalog,bankAt);
  assert.equal(game.guessDeadline,bankAt+GUESS_DURATION_MS);assert.equal(game.banked,200);
  settleClock(game,game.guessDeadline!);assert.equal(game.phase,"miss");assert.equal(game.guessDeadline,null);assert.equal(game.banked,200);
  const nextAt=game.updatedAt+300_000;
  act(game,"next",game.round,game.revision,undefined,catalog,nextAt);
  assert.equal(game.guessDeadline,nextAt+GUESS_DURATION_MS);assert.equal(game.lives,2);
});
test("saved reads retain deadlines across reloads and settle an offscreen pick only once",()=>{
  const db=openStore(":memory:");try{
    const game=fresh(),deadline=game.guessDeadline!;saveGame(db,game);
    const first=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),deadline-1))!;
    assert.equal(first.guessDeadline,deadline);assert.equal(first.revision,0);
    const late=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),deadline+60_000))!;
    assert.equal(late.phase,"miss");assert.equal(late.answered,1);assert.equal(late.lives,2);assert.equal(late.revision,1);
    const reloaded=transaction(db,()=>settleSavedGame(db,findRequest(db,game.player,game.requestId),deadline+120_000))!;
    assert.deepEqual(reloaded,late);
    const staleGuess=act(reloaded,"guess",0,0,winner(reloaded.pair),undefined,deadline+120_000);
    assert.equal(staleGuess.stale,true);assert.equal(reloaded.answered,1);
    correct(game);assert.throws(()=>transaction(db,()=>saveGame(db,game,0)),/changed in another tab/);
  }finally{db.close();}
});
test("legacy untimed snapshots get one persisted window and stale actions cannot reset it",()=>{
  const db=openStore(":memory:");try{
    const game=fresh();delete game.guessDeadline;saveGame(db,game);const firstAccess=5_000_000;
    const migrated=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),firstAccess))!;
    assert.equal(migrated.guessDeadline,firstAccess+GUESS_DURATION_MS);assert.equal(migrated.revision,1);assert.equal(migrated.lives,3);
    const second=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),firstAccess+10_000))!;
    assert.equal(second.guessDeadline,migrated.guessDeadline);assert.equal(second.revision,1);
    const stale=act(second,"guess",0,0,winner(second.pair),undefined,firstAccess+10_000);
    assert.equal(stale.stale,true);assert.equal(second.guessDeadline,migrated.guessDeadline);
    const expired=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),firstAccess+GUESS_DURATION_MS))!;
    assert.equal(expired.lives,2);assert.equal(expired.results[0].timedOut,true);assert.equal(expired.revision,2);
  }finally{db.close();}
});
test("the third timeout finishes and atomically queues one score while keeping banked points",()=>{
  const db=openStore(":memory:");try{
    const game=fresh("account:timed");correct(game);move(game,"bank");correct(game);move(game,"risk");
    saveGame(db,game);let saved=game;let lastDeadline=game.guessDeadline!;
    for(let i=0;i<3;i++){
      lastDeadline=saved.guessDeadline!;
      saved=transaction(db,()=>settleSavedGame(db,findGame(db,game.player),lastDeadline+30_000))!;
      assert.equal(saved.banked,100);assert.equal(saved.pot,0);
      if(i<2){const old=saved.revision;move(saved,"next");transaction(db,()=>saveGame(db,saved,old));}
    }
    assert.equal(saved.phase,"complete");assert.equal(saved.endReason,"lives");assert.equal(saved.completedAt,lastDeadline);assert.equal(saved.lives,0);assert.equal(saved.answered,5);assert.equal(saved.correct,2);
    transaction(db,()=>settleSavedGame(db,findGame(db,game.player),lastDeadline+90_000));queueAccountResult(db,saved);
    const rows=db.prepare("SELECT event FROM account_result_outbox").all();assert.equal(rows.length,1);
    const event=JSON.parse(String(rows[0].event));assert.deepEqual({score:event.score,maxScore:event.maxScore,banked:event.bankedPoints},{score:2,maxScore:5,banked:100});
  }finally{db.close();}
});
test("account handoff preserves a live deadline and settles an expired guest pick before transfer",()=>{
  const db=openStore(":memory:");try{
    const live=fresh("live"),expired=fresh("expired");saveGame(db,live);saveGame(db,expired);
    transaction(db,()=>claimGuestGames(db,"live","one",live.guessDeadline!-1));
    assert.equal(findGame(db,"account:one")?.guessDeadline,live.guessDeadline);
    transaction(db,()=>claimGuestGames(db,"expired","two",expired.guessDeadline!+1));
    const claimed=findGame(db,"account:two")!;assert.equal(claimed.phase,"miss");assert.equal(claimed.lives,2);assert.equal(claimed.results[0].timedOut,true);
  }finally{db.close();}
});

test("discard works from every active phase, forfeits risk and preserves protected points",()=>{
  for(const phase of ["guess","decision","miss"] as const){
    const game=fresh();correct(game);move(game,"bank");correct(game);
    if(phase!=="decision")move(game,"risk");
    if(phase==="miss")wrong(game);
    assert.equal(game.phase,phase);const answered=game.answered,lives=game.lives;
    const result=act(game,"discard",game.round,game.revision,undefined,undefined,game.updatedAt+1);
    assert.equal(result.stale,false);assert.equal(result.game.completionStatus,"incomplete");
    assert.equal(game.phase,"complete");assert.equal(game.endReason,"discarded");
    assert.equal(game.banked,100);assert.equal(game.pot,0);assert.equal(game.ladder,0);
    assert.equal(game.answered,answered);assert.equal(game.lives,lives);assert.equal(game.guessDeadline,null);
    const terminal=structuredClone(game);assert.equal(move(game,"discard").stale,true);assert.deepEqual(game,terminal);
  }
});

test("discard is idempotent and an old request cannot discard a newly created run",()=>{
  const db=openStore(":memory:");try{
    const game=fresh("account:discard");correct(game);move(game,"bank");correct(game);move(game,"risk");saveGame(db,game);
    const originalRevision=game.revision;
    transaction(db,()=>{move(game,"discard");saveGame(db,game,originalRevision);});
    const next=createGame(game.player,catalog,crypto.randomUUID(),{},game.updatedAt+1,historyFor(db,game.player));saveGame(db,next);
    const old=findGame(db,game.player,game.id)!;
    assert.equal(act(old,"discard",old.round,originalRevision,undefined,undefined,old.updatedAt+2).stale,true);
    queueAccountResult(db,old);
    assert.equal(findGame(db,game.player)?.id,next.id);assert.equal(findGame(db,game.player,next.id)?.phase,"guess");
    assert.equal(findGame(db,"account:other",game.id),null);
    const rows=db.prepare("SELECT event FROM account_result_outbox").all();assert.equal(rows.length,1);
    const event=JSON.parse(String(rows[0].event));assert.equal(event.status,"incomplete");assert.equal(event.incompleteReason,"discarded");assert.equal(event.bankedPoints,100);assert.equal(event.won,false);assert.equal(event.correct,2);assert.equal(event.rounds,2);
  }finally{db.close();}
});

test("discard never converts a third timeout into an incomplete run",()=>{
  const game=fresh();wrong(game);move(game,"next");wrong(game);move(game,"next");
  const result=act(game,"discard",game.round,game.revision,undefined,undefined,game.guessDeadline!);
  assert.equal(result.stale,true);assert.equal(game.phase,"complete");assert.equal(game.endReason,"lives");assert.equal(game.completionStatus,"completed");assert.equal(game.answered,3);
  assert.equal(move(game,"discard").stale,true);assert.equal(game.completionStatus,"completed");
});

test("a discard after an elapsed pick first returns the settled state and requires its revision",()=>{
  const game=fresh(),revision=game.revision,deadline=game.guessDeadline!;
  const expired=act(game,"discard",game.round,revision,undefined,undefined,deadline);
  assert.equal(expired.stale,true);assert.equal(game.phase,"miss");assert.equal(game.answered,1);assert.equal(game.lives,2);
  assert.equal(act(game,"discard",game.round,revision,undefined,undefined,deadline+1).stale,true);
  const discarded=act(game,"discard",game.round,game.revision,undefined,undefined,deadline+1);
  assert.equal(discarded.stale,false);assert.equal(discarded.game.completionStatus,"incomplete");assert.equal(game.answered,1);assert.equal(game.lives,2);
});

test("zero-answer guest discards are claimed once and incomplete outbox events survive retries",async()=>{
  const db=openStore(":memory:");try{
    const game=fresh("guest:discard");move(game,"discard");saveGame(db,game);
    assert.equal(db.prepare("SELECT count(*) AS n FROM account_result_outbox").get()!.n,0);
    assert.equal(transaction(db,()=>claimGuestGames(db,game.player,"owner",game.updatedAt+1)),1);
    assert.equal(transaction(db,()=>claimGuestGames(db,game.player,"owner",game.updatedAt+2)),0);
    const claimed=findGame(db,"account:owner",game.id)!;assert.equal(claimed.completionStatus,"incomplete");
    const seen:unknown[]=[];
    assert.equal(await flushAccountResults(db,"account:owner",async events=>{seen.push(events[0]);throw new Error("outage");},10000),false);
    assert.equal(await flushAccountResults(db,"account:owner",async events=>{seen.push(events[0]);return {saved:true};},16000),true);
    assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);
    assert.equal(await flushAccountResults(db,"account:owner",async()=>{throw new Error("already synchronized");},22000),true);
    const event=seen[0] as {status:string;score:number;maxScore:number;rounds:number};
    assert.equal(event.status,"incomplete");assert.equal(event.score,0);assert.equal(event.maxScore,0);assert.equal(event.rounds,0);
  }finally{db.close();}
});

test("retention distinguishes abandoned runs from a completed third timeout",()=>{
  const db=openStore(":memory:");try{
    const abandoned=fresh("account:abandoned");correct(abandoned);move(abandoned,"bank");correct(abandoned);saveGame(db,abandoned);
    const expired=fresh("account:timeout");wrong(expired);move(expired,"next");wrong(expired);move(expired,"next");saveGame(db,expired);
    pruneStore(db,expired.updatedAt+31*86400000,true);
    const incomplete=findGame(db,abandoned.player)!;assert.equal(incomplete.completionStatus,"incomplete");assert.equal(incomplete.endReason,"expired");assert.equal(incomplete.banked,100);assert.equal(incomplete.pot,0);
    const completed=findGame(db,expired.player)!;assert.equal(completed.completionStatus,"completed");assert.equal(completed.endReason,"lives");assert.equal(completed.answered,3);
    const events=db.prepare("SELECT player,event FROM account_result_outbox ORDER BY player").all();assert.equal(events.length,2);
    assert.equal(JSON.parse(String(events[0].event)).status,"incomplete");assert.equal(JSON.parse(String(events[1].event)).status,"completed");
  }finally{db.close();}
});

test("historical terminal rows retain completed classification without inferred migration",()=>{
  const db=openStore(":memory:");try{
    const game=fresh("account:legacy");correct(game);move(game,"cashout");delete game.completionStatus;game.endReason="account-merge";
    saveGame(db,game);assert.equal(publicGame(game).completionStatus,"completed");
    const event=JSON.parse(String(db.prepare("SELECT event FROM account_result_outbox").get()!.event));
    assert.equal(event.status,"completed");assert.equal(event.incompleteReason,undefined);assert.equal(event.won,true);
  }finally{db.close();}
});
