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
