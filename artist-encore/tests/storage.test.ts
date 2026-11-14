import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Database} from "@musical-daily/database";
import type {ArtistPool} from "../src/lib/catalog.ts";
import {findGame,historyFor,openStore,pruneStore,rateLimit,readSavedGame,saveGame,startMix,store,transaction} from "../src/lib/store.ts";
import {createGame} from "../src/lib/engine.ts";
import {applySavedMove} from "../src/lib/game-moves.ts";
import {flushAccountResults} from "../src/lib/account-results.ts";

const pool:ArtistPool={artist:{id:"fixture",name:"Fixture Artist",image:"",url:"https://music.apple.com/"},tracks:Array.from({length:60},(_,i)=>({id:String(i),title:`Track ${i}`,artistId:"fixture",artist:"Fixture Artist",aliases:[],preview:`https://audio-ssl.itunes.apple.com/${i}.m4a`,artwork:"",url:"https://music.apple.com/",duration:200,rank:1000-i})),ranking:{kind:"streams",label:"Fixture",sourceUrl:"https://example.com",asOf:"2026-11-01"},fetchedAt:1};

test("fresh retention uses one marker read without acquiring a write transaction",async()=>{
  const db=await openStore(":memory:"),now=Date.now();
  const calls={execute:0,transaction:0,batch:0};
  const measured:Database={...db,
    execute:(...args)=>{calls.execute++;return db.execute(...args);},
    batch:statements=>{calls.batch++;return db.batch(statements);},
    transaction:fn=>{calls.transaction++;return db.transaction(fn);},
  };
  try{
    await db.execute("INSERT INTO maintenance VALUES('retention',?)",[now-1000]);
    assert.equal((await pruneStore(measured,now)).skipped,true);
    assert.deepEqual(calls,{execute:1,transaction:0,batch:0});
    assert.equal((await pruneStore(measured,now,true)).skipped,false,"Forced maintenance still runs with a fresh marker");
    assert.equal(calls.execute,1,"Forced cleanup does not need a preliminary marker read");
    assert.equal(calls.transaction,1);
  }finally{db.close();}
});

test("retention rechecks the marker after another instance finishes cleanup",async()=>{
  const db=await openStore(":memory:"),now=Date.now();let queries=0,batches=0;
  const concurrent:Database={...db,
    execute:async(...args)=>{
      const result=await db.execute(...args);
      await db.execute("INSERT OR REPLACE INTO maintenance VALUES('retention',?)",[now]);
      return result;
    },
    transaction:fn=>db.transaction(tx=>fn({...tx,
      execute:(...args)=>{queries++;return tx.execute(...args);},
      batch:statements=>{batches++;return tx.batch(statements);},
    })),
  };
  try{
    assert.equal((await pruneStore(concurrent,now)).skipped,true);
    assert.equal(queries,1,"The marker is re-read under the write lock");
    assert.equal(batches,0,"A concurrent cleanup is not repeated");
  }finally{db.close();}
});

test("unchanged saved mixes and missing players need one read without a write transaction",async()=>{
  const db=await openStore(":memory:");const calls={reads:0,transactions:0};
  const measured:Database={...db,execute:(...args)=>{calls.reads++;return db.execute(...args);},transaction:fn=>{calls.transactions++;return db.transaction(fn);}};
  try{
    const game=await startMix(db,"owner",pool,"steady",10000);
    assert.equal((await readSavedGame(measured,"owner",()=>11000))?.id,game.id);
    assert.equal(await readSavedGame(measured,"another-owner",()=>11000),null);
    await applySavedMove(db,"owner",{action:"listen",gameId:game.id,round:0},11000);
    await applySavedMove(db,"owner",{action:"heard",gameId:game.id,round:0},21000);
    assert.equal((await readSavedGame(measured,"owner",()=>22000))?.phase,"guessing");
    assert.deepEqual(calls,{reads:3,transactions:0});
  }finally{db.close();}
});

test("saved-read migrations persist choices and start legacy clocks after the write lock",async()=>{
  const db=await openStore(":memory:");let now=20000,transactions=0;
  const measured:Database={...db,transaction:fn=>{transactions++;now=40000;return db.transaction(fn);}};
  try{
    const game=createGame("owner",pool,[],"legacy",10000);
    game.phase="guessing";delete game.guessDeadline;
    for(const pick of game.picks){delete pick.choices;delete pick.correctChoiceId;}
    await saveGame(db,game);
    const migrated=(await readSavedGame(measured,game.player,()=>now))!;
    assert.equal(migrated.guessDeadline,55000);
    assert.ok(migrated.picks.every(pick=>pick.choices?.length===4&&pick.choices.some(choice=>choice.id===pick.correctChoiceId)));
    const again=(await readSavedGame(measured,game.player,()=>41000))!;
    assert.deepEqual(again.picks,migrated.picks);assert.equal(again.guessDeadline,55000);assert.equal(transactions,1);
  }finally{db.close();}
});

test("concurrent late saved reads score once and preserve terminal outbox repair",async()=>{
  const db=await openStore(":memory:");
  try{
    const game=createGame("account:owner",pool,[],"last-round",10000);
    game.round=9;game.phase="guessing";game.guessDeadline=20000;
    game.results=Array.from({length:9},(_,round)=>({round,title:"Previous",artist:"Fixture Artist",artwork:"",url:"",tier:"hit",input:"",correct:false,skipped:true}));
    await saveGame(db,game);
    const reads=await Promise.all(Array.from({length:5},()=>readSavedGame(db,game.player,()=>21000)));
    assert.ok(reads.every(saved=>saved?.results.length===10&&saved.results[9].timedOut));
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox")).rows[0].n,1);
    await db.execute("DELETE FROM account_result_outbox WHERE game_id=?",[game.id]);
    await readSavedGame(db,game.player,()=>22000);
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox")).rows[0].n,1,"A finalized legacy mix still repairs its missing durable result");
  }finally{db.close();}
});

test("a saved read reconciles the current mix after concurrent replacement",async()=>{
  const db=await openStore(":memory:");let replacementId="";
  try{
    const game=await startMix(db,"owner",pool,"old-mix",10000);
    game.phase="guessing";game.guessDeadline=20000;await saveGame(db,game);
    const concurrent:Database={...db,transaction:async fn=>{
      replacementId=(await startMix(db,game.player,pool,"replacement",22000)).id;
      return db.transaction(fn);
    }};
    const current=await readSavedGame(concurrent,game.player,()=>21000);
    assert.equal(current?.id,replacementId);assert.equal(current?.phase,"ready");
    const replaced=(await findGame(db,game.player,game.id))!;
    assert.equal(replaced.phase,"discarded");assert.equal(replaced.results.length,1);
  }finally{db.close();}
});

test("saved mixes and repetition history survive a closed connection",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"encore-storage-"));
  const path=join(folder,"encore.sqlite");let db=await openStore(path);
  try{
    const game=await startMix(db,"owner",pool,"first",10000);
    await applySavedMove(db,"owner",{action:"listen",gameId:game.id,round:0},11000);
    db.close();db=await openStore(path);
    const restored=await findGame(db,"owner",game.id);
    assert.equal(restored?.listenAt,11000);assert.equal(restored?.phase,"listening");
    assert.equal((await historyFor(db,"owner",pool.artist.id)).length,10);
    assert.equal(await findGame(db,"another-owner",game.id),null);
  }finally{db.close();await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});

test("simultaneous create retries reserve one mix and one exposure per song",async()=>{
  const db=await openStore(":memory:");
  try{
    const games=await Promise.all(Array.from({length:8},()=>startMix(db,"owner",pool,"same-request",10000)));
    assert.equal(new Set(games.map(game=>game.id)).size,1);
    const history=await historyFor(db,"owner",pool.artist.id);
    assert.equal(history.length,10);assert.ok(history.every(track=>track.plays===1));
    assert.equal((await db.execute("SELECT count(*) n FROM games")).rows[0].n,1);
  }finally{db.close();}
});

test("competing new mixes leave exactly one resumable game and preserve incomplete results",async()=>{
  const db=await openStore(":memory:");
  try{
    const games=await Promise.all([startMix(db,"owner",pool,"a",10000),startMix(db,"owner",pool,"b",11000)]);
    const rows=(await db.execute("SELECT state FROM games WHERE json_extract(state,'$.phase') NOT IN ('complete','discarded')")).rows;
    assert.equal(rows.length,1);assert.ok(games.some(game=>game.id===JSON.parse(String(rows[0].state)).id));
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox")).rows[0].n,1);
  }finally{db.close();}
});

test("concurrent answers and stale retries cannot double score a saved mix",async()=>{
  const db=await openStore(":memory:");
  try{
    const game=await startMix(db,"owner",pool,"answers",10000);
    await applySavedMove(db,"owner",{action:"listen",gameId:game.id,round:0},11000);
    await applySavedMove(db,"owner",{action:"heard",gameId:game.id,round:0},21000);
    const move={action:"answer",gameId:game.id,round:0,choiceId:game.picks[0].correctChoiceId};
    const states=await Promise.all(Array.from({length:8},()=>applySavedMove(db,"owner",move,22000)));
    assert.ok(states.every(state=>state.correct===1&&state.results.length===1));
    assert.equal((await findGame(db,"owner",game.id))?.results.length,1);
  }finally{db.close();}
});

test("failed writes roll back all statements and later transactions still work",async()=>{
  const db=await openStore(":memory:");
  try{
    await assert.rejects(transaction(db,async tx=>{
      await tx.execute("INSERT INTO limits VALUES('rollback','moves',1,1)");
      throw new Error("abort this write");
    }),/abort this write/);
    assert.equal((await db.execute("SELECT count(*) n FROM limits")).rows[0].n,0);
    await rateLimit(db,"rollback","moves",1);
    assert.equal((await db.execute("SELECT count(*) n FROM limits")).rows[0].n,1);
  }finally{db.close();}
});

test("rate limits enforce one atomic shared window across concurrent requests",async()=>{
  const db=await openStore(":memory:");
  try{
    const attempts=await Promise.allSettled(Array.from({length:20},()=>rateLimit(db,"owner","create",8,60000,100000)));
    assert.equal(attempts.filter(result=>result.status==="fulfilled").length,8);
    assert.ok(attempts.filter(result=>result.status==="rejected").every(result=>result.reason.status===429));
    assert.equal((await db.execute("SELECT count FROM limits")).rows[0].count,8);
    await rateLimit(db,"owner","create",8,60000,160000);
    assert.equal((await db.execute("SELECT count FROM limits")).rows[0].count,1);
    await rateLimit(db,"another-owner","create",8,60000,160000);
  }finally{db.close();}
});

test("concurrent result flushes claim a retry batch once before publishing",async()=>{
  const db=await openStore(":memory:");
  try{
    const game=await startMix(db,"account:owner",pool,"discard",10000);
    await applySavedMove(db,game.player,{action:"discard",gameId:game.id,round:0},11000);
    let publishes=0;
    const publish=async()=>{publishes++;await new Promise(resolve=>setTimeout(resolve,15));return {saved:true};};
    await Promise.all(Array.from({length:6},()=>flushAccountResults(db,game.player,publish,100000)));
    assert.equal(publishes,1);
    assert.notEqual((await db.execute("SELECT synced_at FROM account_result_outbox")).rows[0].synced_at,null);
  }finally{db.close();}
});

test("an overdue cleanup drains bounded batches before recording daily completion",async t=>{
  const db=await openStore(":memory:");let now=Date.parse("2026-11-06T12:00:00Z");
  const globals=globalThis as typeof globalThis&{encoreStore?:Promise<Database>;encorePrune?:Promise<unknown>;encorePruneAfter?:number};
  const prior={store:globals.encoreStore,prune:globals.encorePrune,after:globals.encorePruneAfter};
  const calls:{queries:number;batches:number;gameDeletes:number}[]=[];
  const tracked:Database={...db,transaction:fn=>db.transaction(async tx=>{
    const count={queries:0,batches:0,gameDeletes:0};calls.push(count);
    return fn({execute:(sql,args)=>{count.queries++;return tx.execute(sql,args);},batch:statements=>{count.batches++;count.gameDeletes+=statements.filter(statement=>statement.sql==="DELETE FROM games WHERE id=?").length;return tx.batch(statements);}});
  })};
  try{
    const expired=Array.from({length:27},(_,i)=>createGame(`expired-${i}`,pool,[],`old-${i}`,now-31*86400000));
    const overflow=Array.from({length:55},(_,i)=>{
      const game=createGame("frequent-player",pool,[],`recent-${i}`,now+i);
      game.phase="discarded";game.completionStatus="incomplete";game.incompleteReason="discarded";game.completedAt=now+i;return game;
    });
    await db.batch([...expired,...overflow].map(game=>({sql:"INSERT INTO games VALUES(?,?,?,?,?)",args:[game.id,game.player,game.requestId,game.createdAt,JSON.stringify(game)]})));
    t.mock.method(Date,"now",()=>now);
    globals.encoreStore=Promise.resolve(tracked);globals.encorePrune=undefined;globals.encorePruneAfter=0;
    for(let batch=0;batch<4;batch++){
      await store();
      const marker=(await db.execute("SELECT last_run FROM maintenance WHERE key='retention'")).rows[0];
      assert.equal(Boolean(marker),batch===3,"Only the final short batch finishes daily retention");
      const completedCalls=calls.length;await store();assert.equal(calls.length,completedCalls,"Backlog work is throttled between immediate requests");
      now+=1001;
    }
    assert.deepEqual(calls.map(call=>call.gameDeletes),[10,10,10,2]);
    assert.ok(calls.every(call=>call.queries===2&&call.batches===1),"Outbox and deletion writes share one batch, independent of game count");
    assert.equal((await db.execute("SELECT count(*) n FROM games")).rows[0].n,50);
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox")).rows[0].n,32);
    await store();assert.equal(calls.length,4,"Completed maintenance does not run again on the next request");
  }finally{
    globals.encoreStore=prior.store;globals.encorePrune=prior.prune;globals.encorePruneAfter=prior.after;db.close();
  }
});

test("queued requests read the clock after their lock wait for deadlines and timeout decisions",async t=>{
  const db=await openStore(":memory:");let now=20000;
  try{
    const game=await startMix(db,"owner",pool,"clock",10000);
    await applySavedMove(db,"owner",{action:"listen",gameId:game.id,round:0},10000);
    t.mock.method(Date,"now",()=>now);
    let release!:()=>void;
    const held=transaction(db,async()=>{await new Promise<void>(resolve=>{release=resolve;});});
    while(!release)await new Promise(resolve=>setTimeout(resolve,0));
    const heard=applySavedMove(db,"owner",{action:"heard",gameId:game.id,round:0});
    now=40000;release();await held;
    const state=await heard;assert.equal(state.guessDeadline,55000,"The player still receives the full fifteen-second guess window");
    let releaseAnswer!:()=>void;
    const anotherLock=transaction(db,async()=>{await new Promise<void>(resolve=>{releaseAnswer=resolve;});});
    while(!releaseAnswer)await new Promise(resolve=>setTimeout(resolve,0));
    now=50000;
    const answer=applySavedMove(db,"owner",{action:"answer",gameId:game.id,round:0,choiceId:game.picks[0].correctChoiceId});
    now=55000;releaseAnswer();await anotherLock;
    const final=await answer;assert.equal(final.results.length,1);assert.equal(final.results[0].timedOut,true);assert.equal(final.correct,0);
  }finally{db.close();}
});
