import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArtistPool } from "../src/lib/catalog.ts";
import type { Game } from "../src/lib/types.ts";
import { act, createGame, finishIncomplete, publicGame, unfinished } from "../src/lib/engine.ts";
import { findGame, openStore, pruneStore, recordMix, saveGame, startMix, transaction } from "../src/lib/store.ts";
import { claimGuestGames, flushAccountResults } from "../src/lib/account-results.ts";
const pool: ArtistPool = { artist: { id: "fixture", name: "Fixture Artist", image: "", url: "https://music.apple.com/" }, tracks: Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `Track ${i}`, artistId: "fixture", artist: "Fixture Artist", aliases: [], preview: `https://audio-ssl.itunes.apple.com/${i}.m4a`, artwork: "", url: "https://music.apple.com/", duration: 200, rank: 1000 - i })), ranking: { kind: "streams", label: "Fixture", sourceUrl: "https://example.com", asOf: "2026-11-01" }, fetchedAt: 1 };
function answer(game: Game, now: number) { act(game, "listen", game.round, "", now); act(game, "heard", game.round, "", now + 10000); act(game, "answer", game.round, game.picks[game.round].correctChoiceId!, now + 11000); }
async function event(db: Awaited<ReturnType<typeof openStore>>, id: string) { return JSON.parse(String((await db.execute("SELECT event FROM account_result_outbox WHERE game_id=?", [id])).rows[0]!.event)); }
test("discarding a fresh mix records zero answered rounds exactly once and cannot resume", async () => {
    const db = await openStore(":memory:");
    const game = await startMix(db, "account:a", pool, "zero", 10000);
    act(game, "discard", 0, "", 11000);
    await saveGame(db, game);
    const restored = (await findGame(db, game.player, game.id))!;
    assert.equal(restored.phase, "discarded");
    assert.equal(restored.incompleteReason, "discarded");
    assert.equal(publicGame(restored).preview, undefined);
    for (const action of ["listen", "heard", "answer", "next", "sync", "discard"])
        act(restored, action, 0, game.picks[0].correctChoiceId!, 20000);
    await saveGame(db, restored);
    assert.equal(restored.results.length, 0);
    assert.equal(restored.completedAt, 11000);
    const result = await event(db, game.id);
    assert.equal(result.status, "incomplete");
    assert.equal(result.rounds, 0);
    assert.equal(result.correct, 0);
    assert.equal(result.maxScore, 10);
    assert.equal(result.won, false);
    let published = 0;
    await flushAccountResults(db, game.player, async (events) => { published += events.length; return { saved: true }; });
    await flushAccountResults(db, game.player, async (events) => { published += events.length; return { saved: true }; });
    assert.equal(published, 1);
    db.close();
});
test("new mixes replace prior active mixes transactionally and idempotent retries cannot reopen them", async () => {
    const db = await openStore(":memory:");
    const first = await startMix(db, "account:a", pool, "first", 10000);
    answer(first, 10000);
    await saveGame(db, first);
    const second = await startMix(db, "account:a", pool, "second", 30000);
    assert.equal((await findGame(db, "account:a", first.id))!.phase, "discarded");
    assert.equal((await event(db, first.id)).incompleteReason, "replaced");
    assert.equal((await event(db, first.id)).correct, 1);
    assert.equal((await event(db, first.id)).rounds, 1);
    const retry = await startMix(db, "account:a", pool, "second", 40000);
    assert.equal(retry.id, second.id);
    const stale = await startMix(db, "account:a", pool, "first", 41000);
    assert.equal(stale.phase, "discarded");
    assert.equal((await findGame(db, "account:a"))!.id, second.id);
    const third = await startMix(db, "account:a", pool, "third", 42000);
    assert.equal((await findGame(db, "account:a"))!.id, third.id);
    assert.equal((await findGame(db, "account:a", second.id))!.phase, "discarded");
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox", [])).rows[0]!.n, 2);
    db.close();
});
test("a failed replacement leaves the old mix and its stats untouched; other identities stay isolated", async () => {
    const db = await openStore(":memory:");
    const saved = await startMix(db, "account:a", pool, "saved", 10000);
    const other = await startMix(db, "account:b", pool, "other", 11000);
    await assert.rejects(async () => await startMix(db, "account:a", { ...pool, tracks: pool.tracks.slice(0, 3) }, "failed", 12000));
    assert.deepEqual(await findGame(db, "account:a", saved.id), JSON.parse(JSON.stringify(saved)));
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox", [])).rows[0]!.n, 0);
    assert.equal(await findGame(db, "account:b", saved.id), null);
    await startMix(db, "account:a", pool, "replacement", 13000);
    assert.deepEqual(await findGame(db, "account:b", other.id), JSON.parse(JSON.stringify(other)));
    db.close();
});
test("ten answered songs remain completed before the final reveal is dismissed", async () => {
    const db = await openStore(":memory:");
    const game = createGame("account:a", pool, [], "full", 10000);
    for (let round = 0; round < 10; round++) {
        answer(game, 10000 + round * 20000);
        if (round < 9)
            act(game, "next", round, "", 22000 + round * 20000);
    }
    assert.equal(game.phase, "reveal");
    await recordMix(db, game);
    act(game, "discard", 9, "", 220000);
    await saveGame(db, game);
    assert.equal(game.phase, "complete");
    assert.equal(game.completionStatus, "completed");
    assert.equal((await event(db, game.id)).status, "completed");
    assert.equal((await event(db, game.id)).rounds, 10);
    assert.equal((await event(db, game.id)).won, true);
    db.close();
});
test("an elapsed tenth guess completes the mix, while an early discard leaves nine answers", async () => {
    const game = createGame("account:a", pool, [], "last", 10000);
    for (let round = 0; round < 9; round++) {
        answer(game, 10000 + round * 20000);
        act(game, "next", round, "", 22000 + round * 20000);
    }
    act(game, "listen", 9, "", 190000);
    act(game, "heard", 9, "", 200000);
    const early = structuredClone(game);
    finishIncomplete(early, "discarded", 214999);
    assert.equal(early.completionStatus, "incomplete");
    assert.equal(early.results.length, 9);
    finishIncomplete(game, "discarded", 215000);
    assert.equal(game.completionStatus, "completed");
    assert.equal(game.results.length, 10);
    assert.equal(game.results[9].timedOut, true);
});
test("retention queues expired account and guest mixes before deleting details", async () => {
    const now = Date.parse("2026-11-03");
    const db = await openStore(":memory:");
    const account = createGame("account:a", pool, [], "old-account", now - 31 * 86400000);
    const guest = createGame("guest", pool, [], "old-guest", now - 31 * 86400000);
    await recordMix(db, account);
    await recordMix(db, guest);
    const result = await pruneStore(db, now, true);
    assert.equal(result.games, 2);
    assert.equal(await findGame(db, account.player, account.id), null);
    assert.equal((await event(db, account.id)).incompleteReason, "expired");
    assert.equal((await event(db, guest.id)).rounds, 0);
    await transaction(db, async (tx) => await claimGuestGames(tx, "guest", "b"));
    assert.equal((await db.execute("SELECT player FROM account_result_outbox WHERE game_id=?", [guest.id])).rows[0]!.player, "account:b");
    await pruneStore(db, now, true);
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox", [])).rows[0]!.n, 2);
    db.close();
});
test("login keeps an account's active mix and retires competing guest mixes without double claiming", async () => {
    const db = await openStore(":memory:");
    const account = await startMix(db, "account:a", pool, "account", 10000);
    const guest = await startMix(db, "guest", pool, "guest", 12000);
    answer(guest, 12000);
    await saveGame(db, guest);
    await transaction(db, async (tx) => await claimGuestGames(tx, "guest", "a"));
    assert.equal((await findGame(db, "account:a"))!.id, account.id);
    assert.equal((await findGame(db, "account:a", guest.id))!.phase, "discarded");
    assert.equal((await event(db, guest.id)).incompleteReason, "account-merge");
    assert.equal((await event(db, guest.id)).rounds, 1);
    assert.equal(await transaction(db, async (tx) => await claimGuestGames(tx, "guest", "a")), 0);
    assert.equal((await db.execute("SELECT count(*) n FROM account_result_outbox", [])).rows[0]!.n, 1);
    db.close();
});
test("login resumes one guest mix when the account has none and retains all finished guest events", async () => {
    const db = await openStore(":memory:");
    const first = await startMix(db, "guest", pool, "first", 10000);
    const active = await startMix(db, "guest", pool, "active", 12000);
    await transaction(db, async (tx) => await claimGuestGames(tx, "guest", "a"));
    assert.equal((await findGame(db, "account:a"))!.id, active.id);
    assert.equal(unfinished((await findGame(db, "account:a", active.id))!), true);
    assert.equal((await event(db, first.id)).status, "incomplete");
    assert.equal((await db.execute("SELECT player FROM account_result_outbox WHERE game_id=?", [first.id])).rows[0]!.player, "account:a");
    db.close();
});
