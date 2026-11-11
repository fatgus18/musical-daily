import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {claimGuestIdentity} from "../src/lib/guest-claim.ts";
import {openStore,saveGame,findGame} from "../src/lib/store.ts";
import {createGame,createDailyGame} from "../src/lib/engine.ts";
import {buildDailyChallenge} from "../src/lib/daily.ts";
import type {Catalog} from "../src/lib/catalog.ts";

const catalog:Catalog={schema:1,version:"0123456789abcdef",createdAt:new Date().toISOString(),sources:[],tracks:Array.from({length:80},(_,i)=>({id:`track-${i}`,title:`Track ${i}`,artist:`Artist ${i}`,primaryArtist:`Artist ${i}`,artwork:"https://example.com/art.jpg",sourceUrl:"https://example.com",popularity:70,metrics:{duration:{value:100+i*4,sourceUrl:"https://example.com"}}}))};
const digest=(token:string)=>createHash("sha256").update(token).digest("hex");

test("central sign-in resumes the guest run without a per-game login and rotates its guest cookie",async()=>{
  const db=await openStore(":memory:");try{
    const token="a".repeat(64),game=createGame(digest(token),catalog,crypto.randomUUID());await saveGame(db,game);
    const rotated=await claimGuestIdentity(db,token,"one");
    assert.match(rotated!,/^[a-f0-9]{64}$/);assert.notEqual(rotated,token);
    assert.equal((await findGame(db,"account:one",game.id))?.id,game.id);
    await claimGuestIdentity(db,token,"two");assert.equal(await findGame(db,"account:two",game.id),null);
    const later=createGame(digest(rotated!),catalog,crypto.randomUUID());await saveGame(db,later);
    await claimGuestIdentity(db,rotated,"two");
    assert.equal((await findGame(db,"account:two",later.id))?.id,later.id);
  }finally{db.close();}
});

test("a daily collision remains bound to the first account and cannot be claimed after account switching",async()=>{
  const db=await openStore(":memory:");try{
    const token="b".repeat(64),now=Date.now(),date=new Date(now).toISOString().slice(0,10);
    const challenge=buildDailyChallenge(catalog,date);
    const existing=createDailyGame("account:one",challenge,crypto.randomUUID(),now);
    const guest=createDailyGame(digest(token),challenge,crypto.randomUUID(),now);
    await saveGame(db,existing);await saveGame(db,guest);
    assert.notEqual(await claimGuestIdentity(db,token,"one"),token);
    assert.equal((await findGame(db,"account:one",existing.id))?.id,existing.id);
    assert.equal((await findGame(db,digest(token),guest.id))?.id,guest.id);
    await claimGuestIdentity(db,token,"two");
    assert.equal(await findGame(db,"account:two",guest.id),null);
    assert.equal((await db.execute("SELECT user_id FROM guest_account_claims")).rows[0].user_id,"one");
  }finally{db.close();}
});

test("central claims serialize concurrent accounts, preserve personal records, and skip empty cookies",async()=>{
  const db=await openStore(":memory:");try{
    assert.equal(await claimGuestIdentity(db,undefined,"one"),undefined);
    assert.equal(await claimGuestIdentity(db,"invalid","one"),undefined);
    const token="c".repeat(64);assert.equal(await claimGuestIdentity(db,token,"one"),token);
    assert.equal((await db.execute("SELECT count(*) n FROM guest_account_claims")).rows[0].n,0);
    await db.execute("INSERT INTO personal_records VALUES(?,?,?)",[digest(token),800,Date.now()]);
    await Promise.all([claimGuestIdentity(db,token,"one"),claimGuestIdentity(db,token,"two")]);
    const owner=String((await db.execute("SELECT user_id FROM guest_account_claims")).rows[0].user_id);
    const records=(await db.execute("SELECT player,banked FROM personal_records")).rows;
    assert.equal(records.length,1);assert.equal(records[0].player,`account:${owner}`);assert.equal(records[0].banked,800);
  }finally{db.close();}
});

test("a failed central claim cannot consume the guest identity",async()=>{
  const db=await openStore(":memory:");try{
    const token="d".repeat(64),player=digest(token);
    // Valid JSON keeps the game's indexed mode expression readable; incomplete
    // state deliberately fails while the merge settles the guest run.
    await db.execute("INSERT INTO games VALUES(?,?,?,?,?,?,?,?)",["broken",player,"broken",0,0,Date.now(),Date.now(),"{}"]);
    await assert.rejects(claimGuestIdentity(db,token,"one"));
    assert.equal((await db.execute("SELECT count(*) n FROM guest_account_claims")).rows[0].n,0);
    assert.equal((await db.execute("SELECT player FROM games")).rows[0].player,player);
  }finally{db.close();}
});
