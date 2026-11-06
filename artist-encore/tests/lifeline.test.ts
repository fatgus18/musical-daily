import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArtistPool } from "../src/lib/catalog.ts";
import { act, createGame, publicGame, replaceClip } from "../src/lib/engine.ts";
import { applySavedMove, validateGameMove } from "../src/lib/game-moves.ts";
import { findGame, openStore, recordMix } from "../src/lib/store.ts";
const pool: ArtistPool = { artist: { id: "apple:123", name: "Fixture Artist", image: "", url: "https://music.apple.com/" }, tracks: Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `Track ${i}`, artistId: "apple:123", artist: "Fixture Artist", aliases: [], preview: `https://audio-ssl.itunes.apple.com/${i}.m4a`, artwork: "", url: "https://music.apple.com/", duration: 200, rank: 1000 - i })), ranking: { kind: "streams", label: "Fixture", sourceUrl: "https://example.com", asOf: "2026-11-01" }, fetchedAt: 1 };
function guessing() { const game = createGame("player", pool, [], "lifeline", 10000); act(game, "listen", 0, "", 10000); act(game, "heard", 0, "", 20000); return game; }
test("50/50 removes exactly two wrong choices, hides private IDs, and never changes the deadline", async () => {
    for (let i = 0; i < 25; i++) {
        const game = guessing();
        const before = publicGame(game, 21000);
        const state = act(game, "fifty-fifty", 0, "", 22000);
        assert.equal(state.choices!.length, 2);
        assert.equal(state.choices!.filter(c => c.id === game.picks[0].correctChoiceId).length, 1);
        assert.equal(game.fiftyFifty!.removedChoiceIds.length, 2);
        assert.equal(new Set(game.fiftyFifty!.removedChoiceIds).size, 2);
        assert.ok(game.fiftyFifty!.removedChoiceIds.every(id => id !== game.picks[0].correctChoiceId));
        assert.deepEqual(state.choices, before.choices!.filter(c => !game.fiftyFifty!.removedChoiceIds.includes(c.id)));
        assert.equal(state.guessDeadline, 35000);
        assert.deepEqual(state.lifeline, { used: true, round: 0, active: true });
        const json = JSON.stringify(state);
        assert.equal(json.includes("correctChoiceId"), false);
        assert.equal(json.includes("removedChoiceIds"), false);
        assert.ok(game.fiftyFifty!.removedChoiceIds.every(id => !json.includes(id)));
    }
});
test("lifeline retries, saved-state reloads, and later clip replacement cannot replenish it", async () => {
    const game = guessing();
    act(game, "fifty-fifty", 0, "", 21000);
    const saved = JSON.stringify(game.fiftyFifty);
    const choices = publicGame(game, 22000).choices;
    act(game, "fifty-fifty", 0, "", 23000);
    assert.equal(JSON.stringify(game.fiftyFifty), saved);
    assert.equal(game.guessDeadline, 35000);
    const restored = JSON.parse(JSON.stringify(game));
    act(restored, "fifty-fifty", 0, "", 24000);
    assert.deepEqual(publicGame(restored, 24000).choices, choices);
    act(restored, "answer", 0, restored.picks[0].correctChoiceId, 25000);
    assert.equal(restored.results[0].correct, true);
    assert.equal(restored.results[0].assisted, true);
    act(restored, "next", 0, "", 26000);
    replaceClip(restored, pool, []);
    assert.equal(JSON.stringify(restored.fiftyFifty), saved);
    act(restored, "listen", 1, "", 27000);
    act(restored, "heard", 1, "", 37000);
    act(restored, "fifty-fifty", 1, "", 38000);
    assert.equal(publicGame(restored, 38000).choices!.length, 4);
    assert.equal(restored.guessDeadline, 52000);
    assert.deepEqual(publicGame(restored).lifeline, { used: true, round: 0, active: false });
});
test("removed options from an old tab are rejected, while either remaining option can be answered once", async () => {
    const game = guessing();
    act(game, "fifty-fifty", 0, "", 21000);
    for (const id of game.fiftyFifty!.removedChoiceIds)
        assert.throws(() => act(game, "answer", 0, id, 22000), /still shown/);
    assert.equal(game.results.length, 0);
    assert.equal(game.guessDeadline, 35000);
    const state = publicGame(game, 23000);
    const wrong = state.choices!.find(c => c.id !== game.picks[0].correctChoiceId)!;
    act(game, "answer", 0, wrong.id, 24000);
    assert.equal(game.results[0].correct, false);
    assert.equal(game.results[0].assisted, true);
    act(game, "answer", 0, game.picks[0].correctChoiceId!, 25000);
    assert.equal(game.results.length, 1);
});
test("50/50 is unavailable before guessing, after the deadline, and on stale rounds", async () => {
    const fresh = createGame("player", pool, [], "fresh", 10000);
    act(fresh, "fifty-fifty", 0, "", 11000);
    assert.equal(fresh.fiftyFifty, undefined);
    act(fresh, "listen", 0, "", 12000);
    act(fresh, "fifty-fifty", 0, "", 13000);
    assert.equal(fresh.fiftyFifty, undefined);
    const game = guessing();
    act(game, "fifty-fifty", 1, "", 22000);
    assert.equal(game.fiftyFifty, undefined);
    const state = act(game, "fifty-fifty", 0, "", 35000);
    assert.equal(state.phase, "reveal");
    assert.equal(game.fiftyFifty, undefined);
    assert.equal(game.results[0].timedOut, true);
    act(game, "fifty-fifty", 0, "", 36000);
    assert.equal(game.results.length, 1);
    assert.equal(game.fiftyFifty, undefined);
});
test("assisted timeout and pass markers survive without inflating scores", async () => {
    for (const action of ["pass", "sync"]) {
        const game = guessing();
        act(game, "fifty-fifty", 0, "", 22000);
        act(game, action, 0, "", action === "sync" ? 35000 : 23000);
        assert.equal(game.results[0].assisted, true);
        assert.equal(publicGame(game).correct, 0);
        assert.equal(publicGame(game).choices, undefined);
        assert.equal(game.results[0].timedOut === true, action === "sync");
    }
});
test("an assisted correct song earns the usual point; later unassisted rounds have no marker", async () => {
    const game = guessing();
    act(game, "fifty-fifty", 0, "", 21000);
    act(game, "answer", 0, game.picks[0].correctChoiceId!, 22000);
    act(game, "next", 0, "", 23000);
    for (let round = 1; round < 10; round++) {
        const now = 30000 + round * 20000;
        act(game, "listen", round, "", now);
        act(game, "heard", round, "", now + 10000);
        act(game, "answer", round, game.picks[round].correctChoiceId!, now + 11000);
        act(game, "next", round, "", now + 12000);
    }
    assert.equal(game.phase, "complete");
    assert.equal(publicGame(game).correct, 10);
    assert.equal(game.results.filter(result => result.assisted).length, 1);
});
test("the API mutation transaction reads current state for retries and enforces owner boundaries", async () => {
    const db = await openStore(":memory:");
    try {
        const game = guessing();
        await recordMix(db, game);
        const move = { action: "fifty-fifty", gameId: game.id, round: 0 };
        await assert.rejects(async () => await applySavedMove(db, "other-player", move, 21000), /another browser/);
        assert.equal((await findGame(db, "player", game.id))!.fiftyFifty, undefined);
        const first = await applySavedMove(db, "player", { ...move, removedChoiceIds: [game.picks[0].correctChoiceId], guessDeadline: 99999999 }, 22000);
        const duplicate = await applySavedMove(db, "player", move, 23000);
        assert.deepEqual(first.choices, duplicate.choices);
        assert.equal(duplicate.guessDeadline, 35000);
        const restored = (await findGame(db, "player", game.id))!;
        const removed = restored.fiftyFifty!.removedChoiceIds[0];
        await assert.rejects(async () => await applySavedMove(db, "player", { action: "answer", gameId: game.id, round: 0, choiceId: removed }, 24000), /still shown/);
        assert.equal((await findGame(db, "player", game.id))!.results.length, 0);
        const answered = await applySavedMove(db, "player", { action: "answer", gameId: game.id, round: 0, choiceId: game.picks[0].correctChoiceId }, 25000);
        assert.equal(answered.correct, 1);
        assert.equal(answered.results[0].assisted, true);
        assert.equal((await applySavedMove(db, "player", move, 26000)).results.length, 1);
    }
    finally {
        db.close();
    }
});
test("API move validation admits only a valid active-round request shape", async () => {
    const valid = { action: "fifty-fifty", gameId: "game-id", round: 0 };
    assert.deepEqual(validateGameMove(valid), valid);
    for (const invalid of [{ ...valid, round: -1 }, { ...valid, round: 10 }, { ...valid, round: "0" }, { ...valid, round: 1.5 }, { ...valid, gameId: null }, { ...valid, gameId: "x".repeat(81) }, { ...valid, action: "free-answer" }, { ...valid, action: "answer", choiceId: [] }])
        assert.throws(() => validateGameMove(invalid));
});
