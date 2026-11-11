import { test } from "node:test";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import { createGame, act } from "../src/lib/engine.ts";
import { openStore, recordMix, saveGame, findGame, historyFor, transaction } from "../src/lib/store.ts";
import { claimGuestGames, flushAccountResults } from "../src/lib/account-results.ts";
import {claimGuestIdentity} from "../src/lib/guest-claim.ts";
import type { Game } from "../src/lib/types.ts";
import type { ArtistPool } from "../src/lib/catalog.ts";
import type {SqlExecutor} from "@musical-daily/database";
const pool: ArtistPool = { artist: { id: "test", name: "Test Artist", image: "", url: "https://music.apple.com/" }, tracks: Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: `Song ${i}`, artistId: "test", artist: "Test Artist", aliases: [], preview: `https://audio-ssl.itunes.apple.com/${i}.m4a`, artwork: "https://is1-ssl.mzstatic.com/a.jpg", url: "https://music.apple.com/", duration: 200, rank: 100 - i })), ranking: { kind: "streams", label: "Test", sourceUrl: "https://example.com", asOf: "2026-11-01" }, fetchedAt: Date.now() };
test("central sign-in claims an existing guest on the first game request and retires that guest cookie",async()=>{
    const db=await openStore(":memory:");try{
        const token="a".repeat(64),player=createHash("sha256").update(token).digest("hex");
        const game=createGame(player,pool,[],"before-hub-login");await recordMix(db,game);
        const nextToken=await claimGuestIdentity(db,token,"central-user");
        assert.match(nextToken!,/^[a-f0-9]{64}$/);assert.notEqual(nextToken,token);
        assert.equal((await findGame(db,"account:central-user",game.id))?.id,game.id);
        assert.equal((await historyFor(db,"account:central-user","test")).length,10);
        await claimGuestIdentity(db,token,"another-user");
        assert.equal(await findGame(db,"account:another-user",game.id),null);
        assert.equal((await db.execute("SELECT user_id FROM guest_account_claims")).rows[0].user_id,"central-user");
        // A later signed-out game uses the rotated cookie and remains claimable.
        const nextPlayer=createHash("sha256").update(nextToken!).digest("hex");
        const later=createGame(nextPlayer,pool,[],"after-logout");await recordMix(db,later);
        await claimGuestIdentity(db,nextToken,"another-user");
        assert.equal((await findGame(db,"account:another-user",later.id))?.id,later.id);
    }finally{db.close();}
});
test("central guest claims are atomic across concurrent accounts and don't store empty guest rows",async()=>{
    const db=await openStore(":memory:");try{
        assert.equal(await claimGuestIdentity(db,undefined,"one"),undefined);
        assert.equal(await claimGuestIdentity(db,"invalid","one"),undefined);
        const empty="b".repeat(64);assert.equal(await claimGuestIdentity(db,empty,"one"),empty);
        assert.equal((await db.execute("SELECT count(*) n FROM guest_account_claims")).rows[0].n,0);
        const token="c".repeat(64),player=createHash("sha256").update(token).digest("hex");
        const game=finish(createGame(player,pool,[],"concurrent"));await recordMix(db,game);
        await Promise.all([claimGuestIdentity(db,token,"one"),claimGuestIdentity(db,token,"two")]);
        const owner=String((await db.execute("SELECT user_id FROM guest_account_claims")).rows[0].user_id);
        assert.ok(owner==="one"||owner==="two");
        assert.equal((await findGame(db,`account:${owner}`,game.id))?.id,game.id);
        assert.equal(await findGame(db,`account:${owner==="one"?"two":"one"}`,game.id),null);
        const events=(await db.execute("SELECT player FROM account_result_outbox")).rows;
        assert.equal(events.length,1);assert.equal(events[0].player,`account:${owner}`);
    }finally{db.close();}
});
test("a failed central guest merge rolls back the claim marker for a safe retry",async()=>{
    const db=await openStore(":memory:");try{
        const token="d".repeat(64),player=createHash("sha256").update(token).digest("hex");
        await db.execute("INSERT INTO games VALUES(?,?,?,?,?)",["broken",player,"broken",Date.now(),"not-json"]);
        await assert.rejects(claimGuestIdentity(db,token,"one"));
        assert.equal((await db.execute("SELECT count(*) n FROM guest_account_claims")).rows[0].n,0);
        assert.equal((await db.execute("SELECT player FROM games")).rows[0].player,player);
    }finally{db.close();}
});
function finish(game: Game) { const start = Date.now() - 200000; for (let round = 0; round < 10; round++) {
    const now = start + round * 19000;
    act(game, "listen", round, "", now);
    act(game, "heard", round, "", now + 10000);
    act(game, round < 6 ? "answer" : "pass", round, game.picks[round].correctChoiceId!, now + 11000);
    if (round < 9)
        act(game, "next", round, "", now + 12000);
} return game; }
test("verified login claims only this browser's guest games and history once", async () => {
    const db = await openStore(":memory:");
    const guest = finish(createGame("guest-a", pool, [], "a"));
    const other = createGame("guest-b", pool, [], "b");
    await recordMix(db, guest);
    await recordMix(db, other);
    assert.equal(await transaction(db, async (tx) => await claimGuestGames(tx, "guest-a", "user-1")), 1);
    assert.equal(await findGame(db, "guest-a", guest.id), null);
    assert.equal((await findGame(db, "account:user-1", guest.id))?.player, "account:user-1");
    assert.ok(await findGame(db, "guest-b", other.id));
    assert.equal(await findGame(db, "account:user-2", guest.id), null);
    const first = await historyFor(db, "account:user-1", "test");
    assert.equal(first.length, 10);
    assert.equal(await transaction(db, async (tx) => await claimGuestGames(tx, "guest-a", "user-1")), 0);
    assert.deepEqual(await historyFor(db, "account:user-1", "test"), first);
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox", [])).rows[0]!.n, 1);
    db.close();
});
test("the last answered song queues one canonical result before the results-page click", async () => {
    const db = await openStore(":memory:");
    const game = finish(createGame("account:user-1", pool, [], "complete"));
    assert.equal(game.phase, "reveal");
    await recordMix(db, game);
    await saveGame(db, game);
    const batches: unknown[] = [];
    assert.equal(await flushAccountResults(db, game.player, async (events) => { batches.push(events); assert.equal(events.length, 1); assert.equal(events[0].score, 6); assert.equal(events[0].correct, 6); assert.equal(events[0].rounds, 10); return { saved: true }; }), true);
    act(game, "next", 9);
    await saveGame(db, game);
    await flushAccountResults(db, game.player, async (events) => { batches.push(events); return { saved: true }; });
    assert.equal(batches.length, 1);
    db.close();
});
test("temporary account-service failures retain results and retries stay isolated", async () => {
    const db = await openStore(":memory:");
    const a = finish(createGame("account:a", pool, [], "a"));
    const b = finish(createGame("account:b", pool, [], "b"));
    await recordMix(db, a);
    await recordMix(db, b);
    const now = Date.now();
    assert.equal(await flushAccountResults(db, a.player, async () => { throw new Error("offline"); }, now), false);
    let calls = 0;
    assert.equal(await flushAccountResults(db, a.player, async () => { calls++; return { saved: true }; }, now + 1000), false);
    assert.equal(calls, 0);
    assert.equal(await flushAccountResults(db, a.player, async (events) => { calls++; assert.equal(events.length, 1); assert.equal(events[0].eventId, a.id); return { saved: true }; }, now + 6000), true);
    assert.equal(calls, 1);
    assert.equal((await db.execute("SELECT synced_at FROM account_result_outbox WHERE game_id=?", [b.id])).rows[0]!.synced_at, null);
    db.close();
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
    const event={eventId:id,mode:"artist",date:"2026-11-11",score:6,maxScore:10,won:false,correct:6,rounds:10,status:"completed"};
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
