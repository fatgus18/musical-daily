import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { AccountStore } from "../../../musical-daily/src/lib/account-store";
import { openStore, recordMix, transaction } from "../../src/lib/store";
import { createGame, act } from "../../src/lib/engine";
import { claimGuestGames } from "../../src/lib/account-results";
import type { ArtistPool } from "../../src/lib/catalog";
test("one account shares server-verified Encore stats across games and hub, then signs out everywhere", async ({ browser }) => {
    const accounts = new AccountStore(resolve("../musical-daily/data/accounts.sqlite"));
    const marker = `integration-${randomUUID()}`;
    const user = await accounts.user({ sub: marker, email: `${marker}@example.invalid`, name: "Integration Listener", picture: null });
    expect((await accounts.user({ sub: marker, email: user.email, name: user.name, picture: null })).id).toBe(user.id);
    const hub = await accounts.createSession(user.id, "hub");
    const encore = await accounts.createSession(user.id, "encore", hub.family);
    const tempo = await accounts.createSession(user.id, "tempo", hub.family);
    const blackjack = await accounts.createSession(user.id, "blackjack", hub.family);
    const cookie = (name: string, value: string) => ({ name, value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" as const });
    const context = await browser.newContext();
    await context.addCookies([cookie("md_hub_session", hub.token), cookie("md_encore_session", encore.token), cookie("md_tempo_session", tempo.token), cookie("md_blackjack_session", blackjack.token)]);
    const db = await openStore();
    let gameId = "";
    try {
        const pool: ArtistPool = { artist: { id: "fixture-artist", name: "Fixture Artist", image: "", url: "https://music.apple.com/" }, tracks: Array.from({ length: 30 }, (_, i) => ({ id: `fixture-${i}`, title: `Fixture ${i}`, artistId: "fixture-artist", artist: "Fixture Artist", aliases: [], preview: `https://audio-ssl.itunes.apple.com/${i}.m4a`, artwork: "https://is1-ssl.mzstatic.com/a.jpg", url: "https://music.apple.com/", duration: 200, rank: 100 - i })), ranking: { kind: "streams", label: "Test fixture", sourceUrl: "https://example.invalid", asOf: new Date().toISOString().slice(0, 10) }, fetchedAt: Date.now() };
        // Private test fixture, not a production login endpoint or browser-provided score.
        const guest = createHash("sha256").update(marker).digest("hex");
        const game = createGame(guest, pool, [], marker, Date.now() - 200000);
        gameId = game.id;
        for (let round = 0; round < 10; round++) {
            const now = Date.now() - 200000 + round * 19000;
            act(game, "listen", round, "", now);
            act(game, "heard", round, "", now + 10000);
            act(game, round < 7 ? "answer" : "pass", round, game.picks[round].correctChoiceId!, now + 11000);
            if (round < 9)
                act(game, "next", round, "", now + 12000);
        }
        await transaction(db, async (tx) => { await recordMix(tx, game); await claimGuestGames(tx, guest, user.id); });
        for (const port of [3000, 3001, 3002, 3004]) {
            const response = await context.request.get(`http://localhost:${port}/api/account/session`);
            expect(response.ok()).toBe(true);
            expect((await response.json()).user.id).toBe(user.id);
        }
        const saved = await context.request.get("http://localhost:3004/api/game");
        expect(saved.ok()).toBe(true);
        const payload = await saved.json();
        expect(payload.game.id).toBe(gameId);
        expect(payload.game.correct).toBe(7);
        expect(payload.statsSynced).toBe(true);
        await context.request.post("http://localhost:3004/api/game", { data: { action: "next", gameId, round: 9 } });
        await context.request.get("http://localhost:3004/api/game");
        const date = new Date().toISOString().slice(0, 10);
        let hand = await (await context.request.get(`http://localhost:3000/api/daily?date=${date}`)).json();
        expect(hand.accountState).toBeTruthy();
        for (const track of hand.tracks) {
            if (hand.accountState.gameOver || hand.accountState.pickedIds.length)
                break;
            const pick = await context.request.post("http://localhost:3000/api/reveal", { headers: { Origin: "http://localhost:3000" }, data: { date, trackId: track.id, accountRevision: hand.accountRevision } });
            expect(pick.ok()).toBe(true);
            hand = await (await context.request.get(`http://localhost:3000/api/daily?date=${date}`)).json();
        }
        if (!hand.accountState.gameOver) {
            const finish = { date, pickedIds: hand.accountState.pickedIds, accountRevision: hand.accountRevision };
            expect((await context.request.post("http://localhost:3000/api/finish", { headers: { Origin: "http://localhost:3000" }, data: finish })).ok()).toBe(true);
            expect((await context.request.post("http://localhost:3000/api/finish", { headers: { Origin: "http://localhost:3000" }, data: finish })).ok()).toBe(true);
        }
        const tempoMix = await (await context.request.get("http://localhost:3002/api/daily")).json();
        expect(tempoMix.accountProgress).toBeTruthy();
        const catalog = JSON.parse(readFileSync(resolve(`../tempo-trap/data/catalog-releases/${tempoMix.version}.json`), "utf8"));
        const tempos = new Map<string, number>(catalog.tracks.map((t: {
            id: string;
            bpm: number;
        }) => [t.id, t.bpm]));
        let token = tempoMix.token;
        for (const track of tempoMix.tracks) {
            const started = await context.request.post("http://localhost:3002/api/round", { headers: { Origin: "http://localhost:3002" }, data: { token } });
            expect(started.ok()).toBe(true);
            const scored = await context.request.post("http://localhost:3002/api/guess", { headers: { Origin: "http://localhost:3002" }, data: { token, guess: Math.round(tempos.get(track.id)!) } });
            expect(scored.ok()).toBe(true);
            const result = await scored.json();
            expect(result.result.score).toBe(1000);
            token = result.token;
        }
        const stats = await (await context.request.get("http://localhost:3001/api/account/stats")).json();
        expect(stats.user.id).toBe(user.id);
        expect(stats.games.blackjack.completed).toBe(1);
        expect(stats.games.tempo.completed).toBe(1);
        expect(stats.games.tempo.bestScore).toBe(5000);
        expect(stats.games.encore.completed).toBe(1);
        expect(stats.games.encore.totalCorrect).toBe(7);
        expect(stats.games.encore.averagePercent).toBe(70);
        const page = await context.newPage();
        await page.goto("http://localhost:3001/stats");
        await expect(page.getByRole("heading", { name: "Encore.", exact: true })).toBeVisible();
        await expect(page.locator(".md-stats-encore")).toContainText("70");
        await expect(page.locator(".md-stats-game-card")).toHaveCount(4);
        const device = await browser.newContext();
        await device.addCookies([cookie("md_encore_session", (await accounts.createSession(user.id, "encore")).token), cookie("md_tempo_session", (await accounts.createSession(user.id, "tempo")).token), cookie("md_blackjack_session", (await accounts.createSession(user.id, "blackjack")).token)]);
        const resumed = await (await device.request.get("http://localhost:3004/api/game")).json();
        expect(resumed.game.id).toBe(gameId);
        expect((await (await device.request.get("http://localhost:3002/api/daily")).json()).accountProgress.phase).toBe("complete");
        expect((await (await device.request.get(`http://localhost:3000/api/daily?date=${date}`)).json()).accountState.gameOver).toBe(true);
        await device.close();
        const other = await browser.newContext();
        expect((await (await other.request.get("http://localhost:3004/api/game")).json()).game).toBeNull();
        expect((await other.request.post("http://localhost:3004/api/game", { data: { action: "sync", gameId, round: 9 } })).status()).toBe(400);
        await other.close();
        const logout = await context.request.post("http://localhost:3004/api/account/logout", { headers: { Origin: "http://localhost:3004" } });
        expect(logout.ok()).toBe(true);
        for (const port of [3000, 3001, 3002, 3004])
            expect((await (await context.request.get(`http://localhost:${port}/api/account/session`)).json()).user).toBeNull();
        await page.reload();
        await expect(page.getByRole("region", { name: "Sign in to save your stats" })).toBeVisible();
        await expect(page.locator(".md-stats-encore")).not.toContainText("Fixture Artist");
    }
    finally {
        await context.close();
        (await db.execute("DELETE FROM account_result_outbox WHERE player=?", [`account:${user.id}`]));
        (await db.execute("DELETE FROM games WHERE id=?", [gameId]));
        (await db.execute("DELETE FROM exposures WHERE player=?", [`account:${user.id}`]));
        db.close();
        await accounts.db.transaction(async tx => { for (const table of ["sessions", "handoffs", "results", "progress"])
            await tx.execute(`DELETE FROM ${table} WHERE user_id=?`, [user.id]); await tx.execute("DELETE FROM users WHERE id=?", [user.id]); });
        accounts.close();
    }
});
