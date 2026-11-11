import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openStore,findGame,findRequest,saveGame,transaction,rateLimit,pruneStore} from "../src/lib/store.ts";
import {persistArtistCatalog,loadSavedCatalog,pinCatalog} from "../src/lib/catalog-storage.ts";
import {catalogVersion,type Catalog} from "../src/lib/catalog.ts";
import {createGame,act} from "../src/lib/engine.ts";
import {winner} from "../src/lib/rules.ts";
import {personalBest} from "../src/lib/records.ts";
import {flushAccountResults} from "../src/lib/account-results.ts";
import type {SqlExecutor} from "@musical-daily/database";

function fixture(label="artist"):Catalog{
  const source="https://music.apple.com/us/artist/test/123";
  const tracks=Array.from({length:6},(_,i)=>({id:`${label}-${i}`,title:`Recording ${i}`,artist:"Test artist",primaryArtist:"Test artist",artwork:"",sourceUrl:source,metrics:{duration:{value:100+i*40,sourceUrl:source}}}));
  const sources=[{id:"test",url:source,note:"Isolated test metadata"}];
  return {schema:1,version:catalogVersion(tracks,sources),createdAt:"2026-11-01T00:00:00.000Z",tracks,sources};
}

test("an artist snapshot and pinned run survive a completely new database connection",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"double-drop-cloud-")),path=join(directory,"state.sqlite");
  let db=await openStore(path);
  try{
    const catalog=await persistArtistCatalog(fixture(),db);
    const game=createGame("guest:cold-start",catalog,crypto.randomUUID(),{},Date.now());
    await transaction(db,async tx=>{await pinCatalog(tx,catalog);await saveGame(tx,game);});
    db.close();db=await openStore(path);
    const saved=(await findGame(db,game.player))!;
    assert.equal((await findRequest(db,game.player,game.requestId))?.id,game.id);
    assert.deepEqual(await loadSavedCatalog(saved.catalogVersion,db),catalog);
    assert.equal(await findGame(db,"guest:another-browser",game.id),null);
    await transaction(db,async tx=>{
      const current=(await findGame(tx,game.player,game.id))!;
      act(current,"guess",current.round,current.revision,winner(current.pair),undefined,game.createdAt+1);
      await saveGame(tx,current,0);
    });
    assert.equal((await findGame(db,game.player))?.correct,1);
  }finally{db.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test("immutable snapshot publication is idempotent and validates cold-read contents",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"double-drop-snapshot-")),path=join(directory,"state.sqlite");
  let db=await openStore(path);
  try{
    const catalog=fixture("immutable");await persistArtistCatalog(catalog,db,1000);
    const repeated=await persistArtistCatalog({...catalog,createdAt:"2026-11-02T00:00:00.000Z"},db,2000);
    assert.equal(repeated.createdAt,catalog.createdAt);
    assert.equal((await db.execute("SELECT count(*) AS n FROM catalog_snapshots")).rows[0].n,1);
    const corrupt=structuredClone(catalog);corrupt.tracks[0].metrics.duration!.value=999;
    await db.execute("UPDATE catalog_snapshots SET payload=? WHERE version=?",[JSON.stringify(corrupt),catalog.version]);
    db.close();db=await openStore(path);
    await assert.rejects(loadSavedCatalog(catalog.version,db),/immutable/);
    await assert.rejects(loadSavedCatalog("../outside",db),/version/);
  }finally{db.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test("retention keeps pinned snapshots and rejects a stale create after an unused pack is removed",async()=>{
  const db=await openStore(":memory:"),now=Date.now();
  try{
    const pinned=await persistArtistCatalog(fixture("pinned"),db,now);
    const unused=await persistArtistCatalog(fixture("unused"),db,now);
    const game=createGame("guest:pinned",pinned,crypto.randomUUID(),{},now);
    await transaction(db,async tx=>{await pinCatalog(tx,pinned,now);await saveGame(tx,game);});
    const pruned=await pruneStore(db,now+40*86400000,true);
    assert.equal(pruned.catalogs,1);
    assert.equal((await db.execute("SELECT version FROM catalog_snapshots")).rows[0].version,pinned.version);
    await assert.rejects(transaction(db,async tx=>{
      await pinCatalog(tx,unused,now+40*86400000);
      await saveGame(tx,createGame("guest:stale",unused,crypto.randomUUID(),{},now));
    }),/expired/);
    assert.equal(await findGame(db,"guest:stale"),null);
  }finally{db.close();}
});

test("rolled-back finalization leaves no result or personal record and concurrent writers cannot double score",async()=>{
  const db=await openStore(":memory:"),catalog=fixture("rollback");
  try{
    const game=createGame("account:rollback",catalog,crypto.randomUUID(),{},Date.now());
    await transaction(db,tx=>saveGame(tx,game));
    await assert.rejects(transaction(db,async tx=>{
      const saved=(await findGame(tx,game.player))!;
      act(saved,"guess",0,0,winner(saved.pair),undefined,game.createdAt+1);
      act(saved,"cashout",saved.round,saved.revision,undefined,undefined,game.createdAt+2);
      await saveGame(tx,saved,0);throw new Error("transaction canceled");
    }),/canceled/);
    assert.equal((await findGame(db,game.player))?.revision,0);
    assert.equal((await db.execute("SELECT count(*) AS n FROM account_result_outbox")).rows[0].n,0);
    assert.equal(await personalBest(db,game.player),null);
    const snapshotA=(await findGame(db,game.player))!,snapshotB=structuredClone(snapshotA);
    for(const snapshot of [snapshotA,snapshotB])act(snapshot,"guess",0,0,winner(snapshot.pair),undefined,game.createdAt+1);
    const results=await Promise.allSettled([transaction(db,tx=>saveGame(tx,snapshotA,0)),transaction(db,tx=>saveGame(tx,snapshotB,0))]);
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    assert.equal((await findGame(db,game.player))?.correct,1);
  }finally{db.close();}
});

test("concurrent request limits are enforced by the database and retention is bounded",async()=>{
  const db=await openStore(":memory:"),catalog=fixture("retention"),now=Date.now();
  try{
    const attempts=await Promise.allSettled(Array.from({length:12},()=>rateLimit(db,"guest:limits","move",5,60000,now)));
    assert.equal(attempts.filter(result=>result.status==="fulfilled").length,5);
    for(let i=0;i<12;i++)await saveGame(db,createGame(`guest:abandoned-${i}`,catalog,crypto.randomUUID(),{},now));
    const first=await pruneStore(db,now+31*86400000,true),second=await pruneStore(db,now+31*86400000);
    assert.equal(first.expired,10);assert.equal(second.expired,2);
    assert.equal((await db.execute("SELECT count(*) AS n FROM games WHERE active=1")).rows[0].n,0);
  }finally{db.close();}
});

function measuredOutbox(db:SqlExecutor){
    const calls={execute:0,batch:0};
    const measured:SqlExecutor={
        execute(sql,args){calls.execute++;return db.execute(sql,args);},
        batch(statements){calls.batch++;return db.batch(statements);},
    };
    return {calls,measured};
}
async function seedOutbox(db:SqlExecutor,id:string,player="account:outbox",lastAttempt=0){
    const event={eventId:id,mode:"practice",date:"2026-11-11",score:6,maxScore:10,won:false,correct:6,rounds:10,status:"completed"};
    await db.execute("INSERT INTO account_result_outbox VALUES(?,?,?,?,?,NULL)",[id,player,JSON.stringify(event),1,lastAttempt]);
}
test("empty outboxes need one database round trip and guests need none",async()=>{
    const db=await openStore(":memory:");try{
        await seedOutbox(db,"other-player","account:other");
        const {calls,measured}=measuredOutbox(db);
        const publish=async()=>{assert.fail("Nothing should be published");};
        assert.equal(await flushAccountResults(measured,"guest",publish,10000),true);
        assert.deepEqual(calls,{execute:0,batch:0});
        assert.equal(await flushAccountResults(measured,"account:outbox",publish,10000),true);
        assert.deepEqual(calls,{execute:0,batch:1});
    }finally{db.close();}
});
test("ACK and pending status share one round trip without hiding concurrent results or leases",async()=>{
    const db=await openStore(":memory:");try{
        await seedOutbox(db,"ready");await seedOutbox(db,"in-flight","account:outbox",9999);
        const {calls,measured}=measuredOutbox(db);
        assert.equal(await flushAccountResults(measured,"account:outbox",async events=>{
            assert.deepEqual(events.map(event=>event.eventId),["ready"]);
            await seedOutbox(db,"arrived-during-publish");
            return {saved:true};
        },10000),false);
        assert.deepEqual(calls,{execute:0,batch:2});
        const rows=(await db.execute("SELECT game_id,synced_at FROM account_result_outbox")).rows;
        assert.notEqual(rows.find(row=>row.game_id==="ready")!.synced_at,null);
        assert.equal(rows.find(row=>row.game_id==="in-flight")!.synced_at,null);
        assert.equal(rows.find(row=>row.game_id==="arrived-during-publish")!.synced_at,null);
        assert.equal(await flushAccountResults(measured,"account:outbox",async events=>{
            assert.deepEqual(events.map(event=>event.eventId),["arrived-during-publish"]);return {saved:true};
        },10001),false);
        // The sole remaining event is leased elsewhere, so this is one batch and no publish.
        const before=calls.batch;
        assert.equal(await flushAccountResults(measured,"account:outbox",async()=>{assert.fail("Lease is still active");},11000),false);
        assert.equal(calls.batch-before,1);
        assert.equal(await flushAccountResults(measured,"account:outbox",async events=>{
            assert.deepEqual(events.map(event=>event.eventId),["in-flight"]);return {saved:true};
        },16000),true);
    }finally{db.close();}
});
test("a failed ACK retains an event for idempotent publication after the lease expires",async()=>{
    const db=await openStore(":memory:");try{
        await seedOutbox(db,"retry-ack");let batches=0;let publishes=0;
        const flaky:SqlExecutor={execute:(sql,args)=>db.execute(sql,args),batch:statements=>{
            if(++batches===2)throw new Error("ACK connection unavailable");return db.batch(statements);
        }};
        const publish=async()=>{publishes++;return {saved:true};};
        assert.equal(await flushAccountResults(flaky,"account:outbox",publish,10000),false);
        assert.equal((await db.execute("SELECT synced_at FROM account_result_outbox")).rows[0].synced_at,null);
        assert.equal(await flushAccountResults(db,"account:outbox",publish,11000),false);
        assert.equal(publishes,1);
        assert.equal(await flushAccountResults(db,"account:outbox",publish,16000),true);
        assert.equal(publishes,2);
    }finally{db.close();}
});
test("a bounded outbox batch reports remaining work until every event is acknowledged",async()=>{
    const db=await openStore(":memory:");try{
        for(let i=0;i<51;i++)await seedOutbox(db,`backlog-${i}`);
        const sizes:number[]=[];const publish=async(events:unknown[])=>{sizes.push(events.length);return {saved:true};};
        assert.equal(await flushAccountResults(db,"account:outbox",publish,10000),false);
        assert.equal(await flushAccountResults(db,"account:outbox",publish,10001),true);
        assert.deepEqual(sizes,[50,1]);
    }finally{db.close();}
});
