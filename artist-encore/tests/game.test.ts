import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArtistPool, Track } from "../src/lib/catalog.ts";
import { answerMatches, selectMix, selectDiscovery, catalogOffer } from "../src/lib/rules.ts";
import { act, createGame, publicGame, replaceClip, expireGuess } from "../src/lib/engine.ts";
import { findGame, historyFor, openStore, recordMix, transaction, pruneStore } from "../src/lib/store.ts";
const tracks: Track[] = Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `Test title ${i}`, aliases: [], artistId: "test", artist: "Test Artist", preview: `https://audio-ssl.itunes.apple.com/test-${i}.m4a`, artwork: "https://is1-ssl.mzstatic.com/art.jpg", url: "https://music.apple.com/us/song/1", duration: 200, rank: 1000 - i }));
const pool: ArtistPool = { artist: { id: "test", name: "Test Artist", image: "", url: "https://music.apple.com/" }, tracks, ranking: { kind: "provider-rank", label: "Test fixture", sourceUrl: "https://example.com", asOf: "2026-11-01" }, fetchedAt: 1 };
test("mixes use exactly six hits, three favorites, one deep cut with no duplicate recordings", async () => {
    for (let i = 0; i < 100; i++) {
        const picks = selectMix(tracks, [], String(i));
        assert.equal(picks.length, 10);
        assert.equal(new Set(picks.map(p => p.track.id)).size, 10);
        assert.deepEqual(["hit", "favorite", "deep"].map(t => picks.filter(p => p.tier === t).length), [6, 3, 1]);
        assert.ok(Math.min(...picks.filter(p => p.tier === "hit").map(p => p.track.rank)) > Math.max(...picks.filter(p => p.tier === "deep").map(p => p.track.rank)));
    }
});
test("repeat selection uses unseen recordings before previously played songs and retains counts", async () => {
    const db = await openStore(":memory:");
    const game = createGame("player", pool, [], "request-1", 10000);
    await transaction(db, async (tx) => await recordMix(tx, game));
    const history = await historyFor(db, "player", "test");
    assert.equal(history.length, 10);
    const next = createGame("player", pool, history, "request-2", 20000);
    assert.equal(next.picks.filter(p => game.picks.some(a => a.track.id === p.track.id)).length, 0);
    await transaction(db, async (tx) => await recordMix(tx, next));
    assert.equal((await historyFor(db, "player", "test")).length, 20);
    assert.equal(await findGame(db, "other", game.id), null);
    db.close();
});
test("undersized, unranked, and tied catalogs cannot silently produce fake deep cuts", async () => {
    assert.throws(() => selectMix(tracks.slice(0, 19), [], "a"));
    assert.throws(() => selectMix(tracks.map(t => ({ ...t, rank: 0 })), [], "b"));
    assert.throws(() => selectMix(tracks.map(t => ({ ...t, rank: 100 })), [], "c"));
});
test("only current audio is public; titles and future clips stay server-side", async () => {
    const game = createGame("player", pool, [], "request-1", 10000);
    const visible = publicGame(game, 10000);
    const json = JSON.stringify(visible);
    assert.equal(visible.preview, game.picks[0].track.preview);
    assert.equal(json.includes(game.picks[0].track.title), false);
    assert.equal(json.includes(game.picks[1].track.preview), false);
    assert.equal(json.includes('"picks"'), false);
});
test("listening must finish, invalid phase and stale actions cannot award or double-count answers", async () => {
    const game = createGame("player", pool, [], "request-1", 10000);
    const title = game.picks[0].correctChoiceId!;
    act(game, "answer", 0, title, 10000);
    assert.equal(game.results.length, 0);
    act(game, "listen", 0, "", 11000);
    act(game, "listen", 0, "", 12000);
    assert.equal(game.listenAt, 11000);
    assert.throws(() => act(game, "heard", 0, "", 15000));
    act(game, "heard", 0, "", 21000);
    act(game, "answer", 0, title, 22000);
    act(game, "answer", 0, title, 23000);
    assert.equal(game.results.length, 1);
    assert.equal(game.results[0].correct, true);
    act(game, "next", 0, "", 24000);
    act(game, "answer", 0, title, 25000);
    assert.equal(game.results.length, 1);
    assert.equal(game.round, 1);
});
test("all ten rounds finish and broken previews are retryable without score penalties", async () => {
    const game = createGame("player", pool, [], "request-1", 10000);
    act(game, "listen", 0, "", 10000);
    act(game, "unavailable", 0, "", 12000);
    assert.equal(game.phase, "ready");
    assert.equal(game.results.length, 0);
    for (let i = 0; i < 10; i++) {
        const now = 20000 + i * 20000;
        act(game, "listen", i, "", now);
        act(game, "heard", i, "", now + 10000);
        act(game, "answer", i, game.picks[i].correctChoiceId!, now + 11000);
        act(game, "next", i, "", now + 12000);
    }
    assert.equal(game.phase, "complete");
    assert.equal(publicGame(game).correct, 10);
    assert.equal(publicGame(game).preview, undefined);
});
test("matching accepts punctuation and sourced aliases without matching partial titles", async () => {
    const track = { ...tracks[0], title: "Don't Stop (feat. Guest)", aliases: ["Don't Stop"] };
    assert.equal(answerMatches(track, "dont stop"), true);
    assert.equal(answerMatches(track, "Don't Stop by Test Artist"), true);
    assert.equal(answerMatches(track, "stop"), false);
    assert.equal(answerMatches(track, "unrelated title"), false);
});
test("unavailable clips can be replaced within the same tier without affecting scores or duplicating the mix", async () => {
    const game = createGame("player", pool, [], "request-1", 10000);
    const original = game.picks[0];
    act(game, "listen", 0, "", 11000);
    const replacement = replaceClip(game, pool, []);
    assert.notEqual(replacement.id, original.track.id);
    assert.equal(game.picks[0].tier, original.tier);
    assert.equal(game.results.length, 0);
    assert.equal(game.phase, "ready");
    assert.equal(new Set(game.picks.map(p => p.track.id)).size, 10);
    assert.equal(game.replaced?.[0], original.track.id);
    act(game, "listen", 0, "", 12000);
    act(game, "heard", 0, "", 22000);
    assert.throws(() => replaceClip(game, pool, []));
});
test("unknown popularity can be played only as an explicit discovery mix without fabricated tiers", async () => {
    const unknown = { ...pool, tracks: tracks.slice(0, 18).map(t => ({ ...t, rank: 0 })), ranking: { ...pool.ranking, kind: "unranked" as const } };
    const offer = catalogOffer(unknown);
    assert.equal(offer.previewable, 18);
    assert.equal(offer.rankedAvailable, false);
    assert.equal(offer.discoveryAvailable, true);
    assert.equal(offer.ranked, 0);
    assert.throws(() => createGame("player", unknown, [], "ranked"));
    const game = createGame("player", unknown, [], "discovery", 10000, "discovery");
    assert.equal(game.picks.length, 10);
    assert.ok(game.picks.every(p => p.tier === "discovery"));
    assert.equal(game.ranking.kind, "unranked");
    assert.equal(publicGame(game).poolSize, 18);
    assert.throws(() => selectDiscovery(unknown.tracks.slice(0, 9), [], "small"));
});
test("discovery draws minimize repetition and replacement preserves an unranked mode", async () => {
    const unknown = { ...pool, tracks: tracks.map(t => ({ ...t, rank: 0 })), ranking: { ...pool.ranking, kind: "unranked" as const } };
    const first = createGame("player", unknown, [], "first", 10000, "discovery");
    const history = first.picks.map(p => ({ id: p.track.id, plays: 1, lastPlayed: 10000 }));
    const next = createGame("player", unknown, history, "next", 20000, "discovery");
    assert.equal(next.picks.filter(p => first.picks.some(a => a.track.id === p.track.id)).length, 0);
    const original = first.picks[0].track.id;
    replaceClip(first, unknown, history);
    assert.notEqual(first.picks[0].track.id, original);
    assert.equal(first.picks[0].tier, "discovery");
});
test("retention removes expired history while preserving current saved mixes", async () => {
    const now = Date.parse("2026-11-01");
    const db = await openStore(":memory:");
    const current = createGame("p", pool, [], "current", now);
    const old = createGame("p", pool, [], "old", now - 200 * 86400000);
    old.phase = "complete";
    await transaction(db, async (tx) => { await recordMix(tx, old); await recordMix(tx, current); });
    (await db.execute("INSERT INTO limits VALUES('stale','search',?,1)", [now - 8 * 86400000]));
    const result = await pruneStore(db, now, true);
    assert.equal(result.games, 1);
    assert.equal(await findGame(db, "p", old.id), null);
    assert.equal((await findGame(db, "p", current.id))?.id, current.id);
    assert.equal(result.limits, 1);
    assert.equal((await pruneStore(db, now)).skipped, true);
    db.close();
});
test("replacement cannot silently change popularity cohorts after a same-day catalog expansion", async () => {
    const game = createGame("player", pool, [], "first");
    assert.throws(() => replaceClip(game, { ...pool, tracks: [...tracks, { ...tracks[0], id: "new", title: "New recording", rank: 9999 }] }, []), /refreshed/);
    assert.equal(game.replaced, undefined);
});
test("completed retention starts at completion rather than original creation", async () => {
    const now = Date.parse("2026-11-01");
    const db = await openStore(":memory:");
    const game = createGame("p", pool, [], "recent-completion", now - 200 * 86400000);
    game.phase = "complete";
    game.completedAt = now;
    await recordMix(db, game);
    await pruneStore(db, now, true);
    assert.equal((await findGame(db, "p", game.id))?.id, game.id);
    db.close();
});
test("the guess window starts only after listening and repeated requests never reset it", async () => {
    const game = createGame("p", pool, [], "timer", 10000);
    assert.equal(game.guessDeadline, undefined);
    act(game, "listen", 0, "", 10000);
    assert.equal(game.guessDeadline, undefined);
    act(game, "heard", 0, "", 20000);
    assert.equal(game.guessDeadline, 35000);
    for (const action of ["heard", "listen", "sync", "unavailable"])
        act(game, action, 0, "", 25000);
    assert.equal(game.guessDeadline, 35000);
    assert.equal(game.phase, "guessing");
    const db = await openStore(":memory:");
    await recordMix(db, game);
    const restored = (await findGame(db, "p", game.id))!;
    assert.equal(restored.guessDeadline, 35000);
    expireGuess(restored, 30000);
    assert.equal(restored.guessDeadline, 35000);
    db.close();
});
test("a late answer expires once; an answer just before the deadline counts", async () => {
    const game = createGame("p", pool, [], "late", 10000);
    act(game, "listen", 0, "", 10000);
    act(game, "heard", 0, "", 20000);
    const timely = structuredClone(game);
    act(timely, "answer", 0, timely.picks[0].correctChoiceId!, 34999);
    assert.equal(timely.results[0].correct, true);
    act(game, "answer", 0, game.picks[0].correctChoiceId!, 35000);
    assert.equal(game.results[0].correct, false);
    assert.equal(game.results[0].timedOut, true);
    assert.equal(game.phase, "reveal");
    act(game, "sync", 0, "", 36000);
    act(game, "answer", 0, game.picks[0].correctChoiceId!, 37000);
    assert.equal(game.results.length, 1);
    act(game, "next", 0, "", 38000);
    assert.equal(game.phase, "ready");
    assert.equal(game.guessDeadline, null);
});
test("timeout reconciliation reveals before a stale next action and legacy deadlines initialize once", async () => {
    const game = createGame("p", pool, [], "legacy", 10000);
    game.phase = "guessing";
    delete game.guessDeadline;
    expireGuess(game, 20000);
    assert.equal(game.guessDeadline, 35000);
    expireGuess(game, 25000);
    assert.equal(game.guessDeadline, 35000);
    act(game, "next", 0, "", 35000);
    assert.equal(game.round, 0);
    assert.equal(game.phase, "reveal");
    assert.equal(game.results.length, 1);
});
