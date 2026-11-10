import test from "node:test";
import assert from "node:assert/strict";
import { AccountStore, randomToken, hash } from "../src/lib/account-store.ts";
import { accountHandlers, createAccountHandlers } from "../src/lib/account-handlers.ts";
import { accountConfig, safeReturnPath } from "../src/lib/account-config.ts";
import type { AccountConfig } from "../src/lib/account-config.ts";
import type { GoogleProvider } from "../src/lib/google-provider.ts";
import { verifiedGoogleIdentity } from "../src/lib/google-provider.ts";
import { makeAccountRoutes, getAccount } from "@musical-daily/accounts/server";
import type { ResultEvent } from "@musical-daily/accounts";

const config: AccountConfig = { hub: "https://music.example", origins: { blackjack: "https://blackjack.example", tempo: "https://tempo.example", encore: "https://encore.example", "double-drop": "https://double-drop.example" }, secret: "test-server-secret-with-32-characters-minimum", clientId: "test-google-client", clientSecret: "test-client-secret", configured: true, database: ":memory:" };
const identity = { sub: "google-sub-123", email: "person@example.com", name: "Listener", picture: null };
function fixture(settings: AccountConfig = config) {
  let now = Date.parse("2026-11-02T12:00:00Z");
  const store = new AccountStore(":memory:", () => now);
  let pending: { state: string; nonce: string; challenge: string };
  const provider: GoogleProvider = {
    authorization(input) { pending = input; return `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}`; },
    async identity(code, verifier, nonce) { assert.equal(code, "valid-google-code"); assert.equal(hash(verifier), pending.challenge); assert.equal(nonce, pending.nonce); return identity; },
  };
  return { store, handlers: createAccountHandlers(settings, store, provider), advance: (ms: number) => { now += ms; } };
}
function request(path: string, cookies = "") { return new Request(`${config.hub}${path}`, { headers: cookies ? { cookie: cookies } : {} }); }
function cookies(response: Response) { return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); }
function service(body: object, secret = config.secret, origin?: string) { return new Request(`${config.hub}/api/account/service`, { method: "POST", headers: { "Content-Type": "application/json", "X-Musical-Daily-Service": secret, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }); }

test("Google subject is the account key; changed email retains identity and same-email subjects remain separate", () => {
  const { store } = fixture();
  const one = store.user(identity); const changed = store.user({ ...identity, email: "new@example.com" }); const other = store.user({ ...identity, sub: "different-provider-sub" });
  assert.equal(one.id, changed.id); assert.notEqual(one.id, other.id); store.close();
});

test("OAuth callback requires browser state and exchanges Google PKCE/nonce once", async () => {
  const { store, handlers } = fixture();
  const login = await handlers.login(request("/api/account/login?returnTo=/stats"));
  assert.equal(login.status, 303); assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax.*Secure/);
  const state = new URL(login.headers.get("location")!).searchParams.get("state");
  const wrong = await handlers.callback(request(`/api/auth/google/callback?state=${state}&code=valid-google-code`));
  assert.match(wrong.headers.get("location")!, /sign-in-failed/);
  const complete = await handlers.callback(request(`/api/auth/google/callback?state=${state}&code=valid-google-code`, cookies(login)));
  assert.equal(complete.headers.get("location"), "https://music.example/stats");
  const session = await (await handlers.session(request("/api/account/session", cookies(complete)))).json(); assert.equal(session.user.email, identity.email);
  const replay = await handlers.callback(request(`/api/auth/google/callback?state=${state}&code=valid-google-code`, cookies(login))); assert.match(replay.headers.get("location")!, /sign-in-failed/);
  store.close();
});

test("game SSO handoff is app + state + PKCE bound, single use, and logout revokes the entire browser family", async () => {
  const { store, handlers } = fixture(); const user = store.user(identity); const hub = store.createSession(user.id, "hub");
  const state = randomToken(); const verifier = randomToken();
  const authorize = await handlers.authorize(request(`/api/auth/authorize?app=encore&state=${state}&challenge=${hash(verifier)}`, `md_hub_session=${hub.token}`));
  const target = new URL(authorize.headers.get("location")!); assert.equal(target.origin, config.origins.encore); const code = target.searchParams.get("code")!;
  assert.equal(store.exchange("tempo", code, state, verifier), null); assert.equal(store.exchange("encore", code, randomToken(), verifier), null); assert.equal(store.exchange("encore", code, state, randomToken()), null);
  const exchange = await handlers.service(service({ app: "encore", action: "exchange", code, state, verifier })); const app = await exchange.json(); assert.equal(app.user.id, user.id);
  assert.equal(store.exchange("encore", code, state, verifier), null); assert.equal(store.session(app.token, "blackjack"), null);
  const logout = await handlers.service(service({ app: "encore", action: "logout", token: app.token })); assert.equal(logout.status, 200);
  assert.equal(store.session(hub.token, "hub"), null); assert.equal(store.session(app.token, "encore"), null); store.close();
});

test("expired state and handoffs cannot create a session", async () => {
  const { store, handlers, advance } = fixture(); const user = store.user(identity); const hub = store.createSession(user.id, "hub"); const verifier = randomToken(); const state = randomToken();
  const code = store.handoff(store.session(hub.token)!, "tempo", state, hash(verifier)); advance(60001); assert.equal(store.exchange("tempo", code, state, verifier), null);
  const login = await handlers.login(request("/api/account/login")); const oauthState = new URL(login.headers.get("location")!).searchParams.get("state"); advance(600001);
  const response = await handlers.callback(request(`/api/auth/google/callback?state=${oauthState}&code=valid-google-code`, cookies(login))); assert.match(response.headers.get("location")!, /sign-in-failed/); store.close();
});

test("service rejects browser writes and unauthenticated result publishing", async () => {
  const { store, handlers } = fixture();
  assert.equal((await handlers.service(service({ app: "encore", action: "result" }, "wrong"))).status, 401);
  assert.equal((await handlers.service(service({ app: "encore", action: "result" }, config.secret, config.hub))).status, 401);
  assert.equal((await handlers.service(service({ app: "encore", action: "result" }))).status, 401);
  assert.equal((await handlers.logout(new Request(`${config.hub}/api/account/logout`, { method: "POST", headers: { Origin: "https://evil.example" } }))).status, 403);
  assert.equal(safeReturnPath("//evil.example"), "/"); assert.equal(safeReturnPath("/\\evil.example"), "/"); assert.equal(safeReturnPath("https://evil.example"), "/"); assert.equal(safeReturnPath("/\t/evil.example"), "/"); assert.equal(safeReturnPath("/\u0000/evil.example"), "/"); store.close();
});

test("daily results are idempotent per account/game/date, validated, and isolated", () => {
  const { store } = fixture(); const a = store.user(identity); const b = store.user({ ...identity, sub: "other" });
  const event = { eventId: "round-1", mode: "daily" as const, date: "2026-11-02", score: 80, maxScore: 100, won: true, correct: 0, rounds: 1 };
  assert.equal(store.result(a.id, "blackjack", event).duplicate, false);
  const duplicate = store.result(a.id, "blackjack", { ...event, eventId: "different-game-id", score: 100 }); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.event.score, 80);
  store.result(b.id, "blackjack", { ...event, score: 20 }); assert.equal(store.stats(a).games.blackjack.played, 1); assert.equal(store.stats(a).games.blackjack.bestScore, 80); assert.equal(store.stats(b).games.blackjack.bestScore, 20);
  assert.throws(() => store.result(a.id, "tempo", { ...event, score: 100001 })); assert.throws(() => store.result(a.id, "encore", event)); store.close();
});

test("progress is account/app scoped, bounded, and uses optimistic revisions", () => {
  const { store } = fixture(); const a = store.user(identity); const b = store.user({ ...identity, sub: "other" });
  assert.deepEqual(store.saveProgress(a.id, "tempo", "daily:2026-11-02", { round: 1 }, 0), { saved: true, revision: 1 });
  const conflict = store.saveProgress(a.id, "tempo", "daily:2026-11-02", { round: 5 }, 0); assert.equal(conflict.conflict, true); assert.deepEqual(conflict.value, { round: 1 });
  assert.equal(store.loadProgress(b.id, "tempo", "daily:2026-11-02"), null); assert.equal(store.loadProgress(a.id, "blackjack", "daily:2026-11-02"), null);
  assert.throws(() => store.saveProgress(a.id, "tempo", "too-big", "a".repeat(131073), 0)); store.close();
});

test("statistics aggregate all games while a bust breaks Blackjack's daily win streak", () => {
  const { store } = fixture(); const user = store.user(identity);
  store.result(user.id, "blackjack", { eventId: "a", mode: "daily", date: "2026-11-01", score: 95, maxScore: 100, won: true });
  store.result(user.id, "blackjack", { eventId: "b", mode: "daily", date: "2026-11-02", score: 0, maxScore: 100, won: false });
  store.result(user.id, "encore", { eventId: "c", mode: "artist", score: 7, maxScore: 10, correct: 7, rounds: 10, artist: { id: "123", name: "Hozier" } });
  const stats = store.stats(user); assert.equal(stats.games.blackjack.currentStreak, 0); assert.equal(stats.games.blackjack.bestStreak, 1); assert.equal(stats.games.encore.averagePercent, 70); assert.equal(stats.games.encore.totalCorrect, 7); assert.equal(stats.games.encore.recent[0].artist?.name, "Hozier"); store.close();
});

test("Tempo streak expires at midnight IST while other games retain their UTC boundary", () => {
  let now = Date.parse("2026-11-09T18:29:59.999Z");
  const store = new AccountStore(":memory:", () => now);
  try {
    const user = store.user(identity);
    for (const game of ["tempo", "blackjack"] as const) {
      store.result(user.id, game, { eventId: "daily:2026-11-08", date: "2026-11-08", mode: "daily", score: 100, maxScore: 100, won: true });
      assert.equal(store.stats(user).games[game].currentStreak, 1);
    }
    now = Date.parse("2026-11-09T18:30:00.000Z");
    assert.equal(store.stats(user).games.tempo.currentStreak, 0);
    assert.equal(store.stats(user).games.blackjack.currentStreak, 1);
    store.result(user.id, "tempo", { eventId: "daily:2026-11-09", date: "2026-11-09", mode: "daily", score: 100, maxScore: 100, won: true });
    assert.equal(store.stats(user).games.tempo.currentStreak, 2);
    store.result(user.id, "tempo", { eventId: "daily:2026-11-10", date: "2026-11-10", mode: "daily", score: 100, maxScore: 100, won: true });
    assert.equal(store.stats(user).games.tempo.currentStreak, 3);
  } finally { store.close(); }
});

test("verified Google claims still require the expected audience, issuer, nonce and verified email", () => {
  const payload = { sub: "one", email: "one@example.com", email_verified: true, aud: config.clientId, iss: "https://accounts.google.com", nonce: "expected-nonce" };
  assert.equal(verifiedGoogleIdentity(payload, config.clientId, "expected-nonce").sub, "one");
  for (const bad of [{ aud: "different-app" }, { nonce: "wrong" }, { iss: "https://evil.example" }, { email_verified: false }, { sub: "" }]) assert.throws(() => verifiedGoogleIdentity({ ...payload, ...bad }, config.clientId, "expected-nonce"));
});

test("saving a completed round and its result is atomic and a stale device cannot publish", () => {
  const { store } = fixture(); const user = store.user(identity); const event = { eventId: "daily-round", mode: "daily" as const, date: "2026-11-02", score: 4000, maxScore: 5000, rounds: 5, correct: 3 };
  store.saveProgress(user.id, "tempo", "daily:2026-11-02", { complete: false }, 0);
  assert.equal(store.saveProgress(user.id, "tempo", "daily:2026-11-02", { complete: true }, 0, event).conflict, true);
  assert.equal(store.stats(user).games.tempo.played, 0);
  const saved = store.saveProgress(user.id, "tempo", "daily:2026-11-02", { complete: true }, 1, event); assert.equal(saved.saved, true); assert.equal(saved.event?.score, 4000); assert.equal(store.stats(user).games.tempo.played, 1);
  assert.throws(() => store.saveProgress(user.id, "tempo", "bad-result", { complete: true }, 0, { ...event, score: -1 })); assert.equal(store.loadProgress(user.id, "tempo", "bad-result"), null); store.close();
});

test("game SDK callback stores only an HttpOnly session, invokes claims once and rejects tampered state", async () => {
  const { store, handlers } = fixture(); const user = store.user(identity); const hub = store.createSession(user.id, "hub");
  const oldFetch = globalThis.fetch; const oldEnv = [process.env.MUSICAL_DAILY_AUTH_ORIGIN, process.env.MUSICAL_DAILY_APP_ORIGIN, process.env.MUSICAL_DAILY_SERVICE_SECRET];
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = config.hub; process.env.MUSICAL_DAILY_APP_ORIGIN = config.origins.encore; process.env.MUSICAL_DAILY_SERVICE_SECRET = config.secret;
  globalThis.fetch = async (input, init) => handlers.service(new Request(input, init));
  let claims = 0;
  const routes = makeAccountRoutes("encore", { async onLogin(account) { assert.equal(account.id, user.id); claims++; } });
  try {
    const login = await routes.login(new Request(`${config.origins.encore}/api/account/login?returnTo=/%09/evil.example`));
    const authorize = new URL(login.headers.get("location")!); const state = authorize.searchParams.get("state")!; const challenge = authorize.searchParams.get("challenge")!;
    const code = store.handoff(store.session(hub.token)!, "encore", state, challenge);
    const bad = await routes.callback(new Request(`${config.origins.encore}/api/account/callback?code=${code}&state=wrong`, { headers: { cookie: cookies(login) } })); assert.match(bad.headers.get("location")!, /sign-in-failed/); assert.equal(claims, 0);
    const callback = await routes.callback(new Request(`${config.origins.encore}/api/account/callback?code=${code}&state=${state}`, { headers: { cookie: cookies(login) } })); assert.equal(callback.headers.get("location"), `${config.origins.encore}/`); assert.equal(claims, 1); assert.match(callback.headers.get("set-cookie")!, /md_encore_session=.*HttpOnly.*Secure/);
    const signed = new Request(`${config.origins.encore}/api/account/session`, { headers: { cookie: cookies(callback) } }); assert.equal((await getAccount(signed, "encore"))?.id, user.id);
    const replay = await routes.callback(new Request(`${config.origins.encore}/api/account/callback?code=${code}&state=${state}`, { headers: { cookie: cookies(login) } })); assert.match(replay.headers.get("location")!, /sign-in-failed/); assert.equal(claims, 1);
  } finally { globalThis.fetch = oldFetch; ["MUSICAL_DAILY_AUTH_ORIGIN", "MUSICAL_DAILY_APP_ORIGIN", "MUSICAL_DAILY_SERVICE_SECRET"].forEach((key, index) => { const value = oldEnv[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); store.close(); }
});

test("an account service outage preserves signed-in failure while standalone guests can play", async () => {
  const oldFetch = globalThis.fetch; const oldEnv = [process.env.MUSICAL_DAILY_AUTH_ORIGIN, process.env.MUSICAL_DAILY_APP_ORIGIN, process.env.MUSICAL_DAILY_SERVICE_SECRET];
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = config.hub; process.env.MUSICAL_DAILY_APP_ORIGIN = config.origins.encore; process.env.MUSICAL_DAILY_SERVICE_SECRET = config.secret;
  globalThis.fetch = async () => { throw new Error("Offline"); };
  try {
    const routes = makeAccountRoutes("encore"); const guest = new Request(`${config.origins.encore}/api/account/session`); const signed = new Request(guest.url, { headers: { cookie: `md_encore_session=${randomToken()}` } });
    assert.equal(await getAccount(guest, "encore"), null); assert.deepEqual(await (await routes.session(guest)).json(), { user: null, configured: false });
    await assert.rejects(getAccount(signed, "encore")); assert.equal((await routes.session(signed)).status, 503);
    process.env.MUSICAL_DAILY_AUTH_ORIGIN = "ftp://localhost:3001"; await assert.rejects(getAccount(signed, "encore"), /Invalid account service origin/);
  } finally { globalThis.fetch = oldFetch; ["MUSICAL_DAILY_AUTH_ORIGIN", "MUSICAL_DAILY_APP_ORIGIN", "MUSICAL_DAILY_SERVICE_SECRET"].forEach((key, index) => { const value = oldEnv[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
});

test("bulk results validate the entire batch, deduplicate retries, and remain account isolated", async () => {
  const { store, handlers } = fixture(); const user = store.user(identity); const other = store.user({ ...identity, sub: "another-account" }); const session = store.createSession(user.id, "encore");
  const events = Array.from({ length: 50 }, (_, index) => ({ eventId: `encore-${index}`, mode: "artist" as const, score: index % 11, maxScore: 10, correct: index % 11, rounds: 10, artist: { id: "123", name: "Hozier" } }));
  const invalid = await handlers.service(service({ app: "encore", action: "results", token: session.token, events: [...events.slice(0, 49), { ...events[49], score: 99 }] })); assert.equal(invalid.status, 400); assert.equal(store.stats(user).games.encore.played, 0);
  for (let retry = 0; retry < 2; retry++) { const response = await handlers.service(service({ app: "encore", action: "results", token: session.token, events })); assert.deepEqual(await response.json(), { saved: true }); }
  assert.equal(store.stats(user).games.encore.played, 50); assert.equal(store.stats(other).games.encore.played, 0); assert.equal(store.stats(user).games.tempo.played, 0);
  assert.throws(() => store.results(user.id, "encore", [...events, events[0]])); store.close();
});

test("development reload refreshes store methods without replacing an active SQLite connection", () => {
  const shared = globalThis as typeof globalThis & { musicalDailyAccounts?: { path: string; store: AccountStore } }; const old = shared.musicalDailyAccounts; const oldPath = process.env.ACCOUNTS_DB_PATH;
  const { store } = fixture(); const connection = store.db; const stalePrototype = Object.create(AccountStore.prototype); Object.defineProperty(stalePrototype, "results", { value: undefined }); Object.setPrototypeOf(store, stalePrototype);
  shared.musicalDailyAccounts = { path: ":memory:", store }; process.env.ACCOUNTS_DB_PATH = ":memory:";
  try { assert.equal(typeof store.results, "undefined"); accountHandlers(); assert.equal(typeof store.results, "function"); assert.equal(store.db, connection); } finally { shared.musicalDailyAccounts = old; if (oldPath === undefined) delete process.env.ACCOUNTS_DB_PATH; else process.env.ACCOUNTS_DB_PATH = oldPath; store.close(); }
});

test("operational storage failures return retryable 503 without logging credentials or payloads", async () => {
  const { store, handlers } = fixture(); const user = store.user(identity); const session = store.createSession(user.id, "encore"); const logs: unknown[][] = []; const oldLog = console.error;
  store.results = () => { throw new TypeError("Sensitive internal detail that must not escape"); }; console.error = (...args: unknown[]) => { logs.push(args); };
  try { const response = await handlers.service(service({ app: "encore", action: "results", token: session.token, events: [] })); assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /Sensitive/); assert.doesNotMatch(JSON.stringify(logs), /Sensitive|events|token/); assert.match(JSON.stringify(logs), /TypeError/); } finally { console.error = oldLog; store.close(); }
});

test("Double or Drop banks and accuracy aggregate independently and retries cannot double-count points", () => {
  const { store } = fixture(); const user = store.user(identity); const other = store.user({ ...identity, sub: "another-drop-player" });
  const event = { eventId: "double-run-one", mode: "practice" as const, score: 6, maxScore: 8, correct: 6, rounds: 8, bankedPoints: 700, won: true };
  store.result(user.id, "double-drop", event);
  assert.equal(store.result(user.id, "double-drop", { ...event, bankedPoints: 900 }).duplicate, true);
  store.result(user.id, "double-drop", { ...event, eventId: "double-run-two", score: 1, maxScore: 4, correct: 1, rounds: 4, bankedPoints: 0, won: false });
  const stats = store.stats(user).games["double-drop"];
  assert.equal(stats.played, 2); assert.equal(stats.wins, 1); assert.equal(stats.totalBanked, 700); assert.equal(stats.bestBanked, 700);
  assert.equal(stats.averagePercent, 58); assert.equal(stats.totalCorrect, 7); assert.equal(stats.totalRounds, 12);
  assert.equal(store.stats(other).games["double-drop"].totalBanked, 0); assert.equal(store.stats(user).games.encore.played, 0);
  store.close();
});

test("Double or Drop rejects impossible money, incompatible modes, and inaccurate comparison totals", () => {
  const { store } = fixture(); const user = store.user(identity);
  const event = { eventId: "valid-run", mode: "practice" as const, score: 2, maxScore: 4, correct: 2, rounds: 4, bankedPoints: 100, won: true };
  for (const invalid of [{ bankedPoints: -1 }, { bankedPoints: 1.5 }, { bankedPoints: Infinity }, { bankedPoints: 1000000001 }, { bankedPoints: undefined }, { won: false }, { score: 1 }, { rounds: 5 }, { correct: 0 }, { mode: "artist" }]) {
    assert.throws(() => store.result(user.id, "double-drop", { ...event, ...invalid } as typeof event));
  }
  assert.throws(() => store.result(user.id, "tempo", event));
  assert.equal(store.stats(user).games["double-drop"].played, 0); store.close();
});

test("daily Double or Drop results are date-idempotent, labelled, bounded and separate from unlimited", () => {
  const { store } = fixture(); const user = store.user(identity);
  const daily: ResultEvent = { eventId: "daily-drop-1", mode: "daily", date: "2026-11-02", score: 8, maxScore: 10, correct: 8, rounds: 10, bankedPoints: 800, won: true };
  store.result(user.id, "double-drop", daily);
  const retry = store.result(user.id, "double-drop", { ...daily, eventId: "daily-reroll", score: 10, correct: 10, bankedPoints: 1000 });
  assert.equal(retry.duplicate, true); assert.equal(retry.event.score, 8);
  store.result(user.id, "double-drop", { ...daily, eventId: "unlimited-today", mode: "practice" });
  const stats = store.stats(user).games["double-drop"];
  assert.equal(stats.played, 2); assert.equal(stats.totalBanked, 1600); assert.equal(stats.currentStreak, 1);
  assert.deepEqual(new Set(stats.recent.map(entry => entry.mode)), new Set(["daily", "practice"]));
  assert.throws(() => store.result(user.id, "double-drop", { ...daily, eventId: "too-many", date: "2026-11-01", maxScore: 11, rounds: 11 }));
  assert.throws(() => store.result(user.id, "double-drop", { ...daily, eventId: "no-date", date: undefined }));
  store.close();
});

test("discarding a daily attempt records its actual answers and cannot be replaced by a win", () => {
  const { store } = fixture(); const user = store.user(identity);
  const discarded: ResultEvent = { eventId: "daily-discard", mode: "daily", date: "2026-11-02", status: "incomplete", incompleteReason: "discarded", score: 0, maxScore: 0, correct: 0, rounds: 0, bankedPoints: 0, won: false };
  store.result(user.id, "double-drop", discarded);
  const retry = store.result(user.id, "double-drop", { ...discarded, eventId: "daily-retry", status: "completed", incompleteReason: undefined, score: 10, maxScore: 10, correct: 10, rounds: 10, bankedPoints: 1000, won: true });
  assert.equal(retry.duplicate, true); assert.equal(retry.event.status, "incomplete");
  const stats = store.stats(user).games["double-drop"];
  assert.equal(stats.incomplete, 1); assert.equal(stats.completed, 0); assert.equal(stats.totalRounds, 0); assert.equal(stats.currentStreak, 0);
  store.close();
});

test("Double or Drop uses the existing Google identity through an app-bound SSO handoff", async () => {
  const { store, handlers } = fixture(); const user = store.user(identity); const hub = store.createSession(user.id, "hub");
  const state = randomToken(); const verifier = randomToken();
  const authorize = await handlers.authorize(request(`/api/auth/authorize?app=double-drop&state=${state}&challenge=${hash(verifier)}`, `md_hub_session=${hub.token}`));
  const target = new URL(authorize.headers.get("location")!); assert.equal(target.origin, config.origins["double-drop"]);
  const code = target.searchParams.get("code")!; assert.equal(store.exchange("encore", code, state, verifier), null);
  const exchange = await handlers.service(service({ app: "double-drop", action: "exchange", code, state, verifier }));
  const session = await exchange.json(); assert.equal(session.user.id, user.id);
  const event = { eventId: "sso-double-run", mode: "practice", score: 3, maxScore: 4, correct: 3, rounds: 4, bankedPoints: 500, won: true };
  assert.equal((await handlers.service(service({ app: "double-drop", action: "result", token: session.token, event }))).status, 200);
  assert.equal(store.stats(user).games["double-drop"].totalBanked, 500); store.close();
});

test("Double or Drop final results at the engine's comparison limit remain publishable", () => {
  const { store } = fixture(); const user = store.user(identity);
  // Keep this boundary aligned with the engine's MAX_COMPARISONS safety limit.
  const rounds = 1_000_000;
  const banked = { eventId: "limit-banked", mode: "practice" as const, score: rounds, maxScore: rounds, correct: rounds, rounds, bankedPoints: 100, won: true };
  store.result(user.id, "double-drop", banked);
  store.result(user.id, "double-drop", { ...banked, eventId: "limit-missed", score: rounds - 1, correct: rounds - 1, bankedPoints: 0, won: false });
  assert.equal(store.stats(user).games["double-drop"].played, 2);
  assert.equal(store.stats(user).games["double-drop"].totalRounds, 2_000_000);
  assert.equal(store.stats(user).games["double-drop"].totalBanked, 100);
  assert.throws(() => store.result(user.id, "double-drop", { ...banked, eventId: "over-limit", score: rounds + 1, correct: rounds + 1, maxScore: rounds + 1, rounds: rounds + 1 }));
  store.close();
});

test("incomplete Encore mixes count actual answers without earning completion scores, wins or streaks", () => {
  const { store } = fixture(); const user = store.user(identity);
  const base = { mode: "artist" as const, maxScore: 10, artist: { id: "123", name: "Hozier" } };
  store.result(user.id, "encore", { ...base, eventId: "finished", score: 6, correct: 6, rounds: 10, won: false });
  const unfinished: ResultEvent = { ...base, eventId: "unfinished", status: "incomplete", incompleteReason: "replaced", score: 9, correct: 9, rounds: 9, won: false };
  store.result(user.id, "encore", unfinished);
  assert.equal(store.result(user.id, "encore", unfinished).duplicate, true);
  const stats = store.stats(user).games.encore;
  assert.equal(stats.played, 2); assert.equal(stats.completed, 1); assert.equal(stats.incomplete, 1);
  assert.equal(stats.wins, 0); assert.equal(stats.totalScore, 6); assert.equal(stats.bestScore, 6); assert.equal(stats.averageScore, 6);
  assert.equal(stats.totalCorrect, 15); assert.equal(stats.totalRounds, 19); assert.equal(stats.averagePercent, 79);
  assert.equal(stats.currentStreak, 1);
  const recent = stats.recent.find(entry => entry.eventId === unfinished.eventId)!;
  assert.equal(recent.status, "incomplete"); assert.equal(recent.incompleteReason, "replaced"); assert.equal(recent.rounds, 9); assert.equal(recent.correct, 9); assert.equal(recent.artist?.name, "Hozier");
  assert.equal(stats.recent.find(entry => entry.eventId === "finished")?.status, "completed");
  store.close();
});

test("zero-answer incomplete runs are recorded without invented accuracy or completed scores", () => {
  const { store } = fixture(); const user = store.user(identity); const other = store.user({ ...identity, sub: "incomplete-other" });
  store.result(user.id, "encore", { eventId: "empty-encore", status: "incomplete", incompleteReason: "discarded", mode: "artist", score: 0, maxScore: 10, correct: 0, rounds: 0, won: false });
  store.result(user.id, "double-drop", { eventId: "empty-drop", status: "incomplete", incompleteReason: "discarded", mode: "practice", score: 0, maxScore: 0, correct: 0, rounds: 0, won: false, bankedPoints: 0 });
  for (const game of ["encore", "double-drop"] as const) {
    const stats = store.stats(user).games[game];
    assert.equal(stats.played, 1); assert.equal(stats.completed, 0); assert.equal(stats.incomplete, 1);
    assert.equal(stats.wins, 0); assert.equal(stats.averagePercent, 0); assert.equal(stats.averageScore, 0);
    assert.equal(stats.totalRounds, 0); assert.equal(stats.totalCorrect, 0); assert.equal(stats.bestScore, 0);
    assert.equal(stats.currentStreak, 0); assert.equal(stats.bestStreak, 0); assert.equal(stats.recent[0].status, "incomplete");
    assert.equal(store.stats(other).games[game].played, 0);
  }
  store.close();
});

test("incomplete Double or Drop runs retain protected banks and misses without counting as wins", () => {
  const { store } = fixture(); const user = store.user(identity);
  const complete: ResultEvent = { eventId: "drop-complete", mode: "practice", status: "completed", score: 1, maxScore: 1, correct: 1, rounds: 1, bankedPoints: 100, won: true };
  const incomplete: ResultEvent = { eventId: "drop-incomplete", mode: "practice", status: "incomplete", incompleteReason: "discarded", score: 4, maxScore: 8, correct: 4, rounds: 8, bankedPoints: 700, won: false };
  store.results(user.id, "double-drop", [complete, incomplete]);
  const retry = store.result(user.id, "double-drop", { ...incomplete, status: "completed", incompleteReason: undefined, won: true });
  assert.equal(retry.duplicate, true); assert.equal(retry.event.status, "incomplete");
  const stats = store.stats(user).games["double-drop"];
  assert.equal(stats.played, 2); assert.equal(stats.completed, 1); assert.equal(stats.incomplete, 1); assert.equal(stats.wins, 1);
  assert.equal(stats.totalBanked, 800); assert.equal(stats.bestBanked, 700);
  assert.equal(stats.totalCorrect, 5); assert.equal(stats.totalRounds, 9); assert.equal(stats.averagePercent, 56);
  assert.equal(stats.totalScore, 1); assert.equal(stats.bestScore, 1); assert.equal(stats.averageScore, 1);
  const recent = stats.recent.find(entry => entry.eventId === incomplete.eventId)!;
  assert.equal(recent.bankedPoints, 700); assert.equal(recent.status, "incomplete"); assert.equal(recent.won, false);
  store.close();
});

test("incomplete results reject invalid statuses, reasons, rewards, modes and answer denominators", () => {
  const { store } = fixture(); const user = store.user(identity);
  const encore: ResultEvent = { eventId: "invalid-encore", mode: "artist", status: "incomplete", incompleteReason: "replaced", score: 1, maxScore: 10, correct: 1, rounds: 3, won: false };
  for (const invalid of [{ status: "abandoned" }, { status: null }, { won: true }, { incompleteReason: "unknown" }, { status: "completed" }, { rounds: -1 }, { rounds: 10 }, { rounds: undefined }, { correct: undefined }, { correct: 4 }, { score: 2 }, { maxScore: 0 }, { mode: "practice" }, { mode: "daily", date: "2026-11-02" }]) {
    assert.throws(() => store.result(user.id, "encore", { ...encore, ...invalid } as ResultEvent), JSON.stringify(invalid));
  }
  for (const game of ["tempo", "blackjack"] as const) assert.throws(() => store.result(user.id, game, { ...encore, mode: "practice" }));
  const drop: ResultEvent = { eventId: "invalid-drop", mode: "practice", status: "incomplete", incompleteReason: "discarded", score: 0, maxScore: 0, correct: 0, rounds: 0, won: false, bankedPoints: 0 };
  for (const invalid of [{ status: "completed", incompleteReason: undefined }, { won: true }, { bankedPoints: 100 }, { correct: 1 }, { maxScore: 1 }, { rounds: 1 }]) assert.throws(() => store.result(user.id, "double-drop", { ...drop, ...invalid } as ResultEvent));
  assert.equal(store.stats(user).games.encore.played, 0); assert.equal(store.stats(user).games["double-drop"].played, 0);
  store.close();
});

test("expired and account-merge results publish once and an invalid incomplete batch stays atomic", () => {
  const { store } = fixture(); const user = store.user(identity);
  const base: ResultEvent = { eventId: "one", status: "incomplete", mode: "artist", score: 0, maxScore: 10, correct: 0, rounds: 2, won: false };
  const events = [ { ...base, eventId: "expired", incompleteReason: "expired" as const }, { ...base, eventId: "merge", incompleteReason: "account-merge" as const } ];
  assert.throws(() => store.results(user.id, "encore", [...events, { ...base, eventId: "bad", won: true }]));
  assert.equal(store.stats(user).games.encore.played, 0);
  store.results(user.id, "encore", events); store.results(user.id, "encore", events);
  assert.equal(store.stats(user).games.encore.incomplete, 2); assert.equal(store.stats(user).games.encore.totalRounds, 4);
  assert.equal(store.stats(user).games.encore.currentStreak, 0); store.close();
});

test("guest preview handles stale cookies without opening SQLite, configuring Google, or contacting an account server", async (context) => {
  const environment = ["NEXT_PUBLIC_GUEST_ONLY", "ACCOUNTS_DB_PATH", "MUSICAL_DAILY_AUTH_ORIGIN"] as const;
  const previous = environment.map(key => process.env[key]);
  const storeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "musicalDailyAccounts");
  // A directory is never a valid SQLite database. No new file is needed to
  // prove that these routes can operate without access to an account database.
  process.env.NEXT_PUBLIC_GUEST_ONLY = "1";
  process.env.ACCOUNTS_DB_PATH = process.cwd();
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = "not-an-origin";
  Object.defineProperty(globalThis, "musicalDailyAccounts", {
    configurable: true,
    get() { throw new Error("Guest preview must not access the shared account store"); },
    set() { throw new Error("Guest preview must not initialize the shared account store"); },
  });
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Guest accounts must not make network requests"); });
  try {
    const handlers = accountHandlers();
    const stale = `md_hub_session=${randomToken()}; md_google_flow=${randomToken()}`;
    const response = await handlers.session(request("/api/account/session", stale));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: null, configured: false });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await handlers.stats(request("/api/account/stats", stale))).status, 401);
    for (const route of ["login", "authorize", "callback", "service"] as const) {
      const disabled = await handlers[route](request(`/api/account/${route}`, stale));
      assert.equal(disabled.status, 503, route);
      assert.equal(disabled.headers.get("Location"), null, `${route} must not redirect to OAuth`);
      assert.equal((await disabled.json()).configured, false);
    }
    const crossOrigin = new Request(`${config.hub}/api/account/logout`, { method: "POST", headers: { Origin: "https://other.example", cookie: stale } });
    assert.equal((await handlers.logout(crossOrigin)).status, 403);
    const logout = await handlers.logout(new Request(`${config.hub}/api/account/logout`, { method: "POST", headers: { Origin: config.hub, cookie: stale } }));
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });
    assert.equal(logout.headers.getSetCookie().length, 2);
    for (const cookie of logout.headers.getSetCookie()) assert.match(cookie, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure/);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    if (storeDescriptor) Object.defineProperty(globalThis, "musicalDailyAccounts", storeDescriptor);
    else delete (globalThis as typeof globalThis & { musicalDailyAccounts?: unknown }).musicalDailyAccounts;
    environment.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

test("services OAuth handoffs return every game to its public callback path on the hub domain", async () => {
  const environment = ["NEXT_PUBLIC_MUSICAL_DAILY_SERVICES", "MUSICAL_DAILY_AUTH_ORIGIN", "MUSICAL_DAILY_SERVICE_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const previous = environment.map(key => process.env[key]);
  process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES = "1";
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = config.hub;
  process.env.MUSICAL_DAILY_SERVICE_SECRET = config.secret;
  process.env.GOOGLE_CLIENT_ID = config.clientId;
  process.env.GOOGLE_CLIENT_SECRET = config.clientSecret;
  const settings = accountConfig();
  const { store, handlers } = fixture(settings);
  const mounts = { blackjack: "/blackjack", tempo: "/tempo-trap", encore: "/encore", "double-drop": "/double-or-drop" } as const;
  try {
    for (const app of Object.keys(mounts) as (keyof typeof mounts)[]) {
      const state = randomToken(); const verifier = randomToken();
      const login = await handlers.authorize(request(`/api/auth/authorize?app=${app}&state=${state}&challenge=${hash(verifier)}`));
      assert.equal(login.status, 303);
      const oauthState = new URL(login.headers.get("Location")!).searchParams.get("state");
      const complete = await handlers.callback(request(`/api/auth/google/callback?state=${oauthState}&code=valid-google-code`, cookies(login)));
      const callback = new URL(complete.headers.get("Location")!);
      assert.equal(callback.origin, config.hub, app);
      assert.equal(callback.pathname, `${mounts[app]}/api/account/callback`, app);
      assert.equal(callback.searchParams.get("state"), state);
      const code = callback.searchParams.get("code")!;
      const exchanged = store.exchange(app, code, state, verifier);
      assert.equal(exchanged?.user.email, identity.email, app);
      assert.equal(store.exchange(app, code, state, verifier), null, `${app} handoff remains single-use`);

      // An existing hub session must use the same callback prefix without
      // starting a second Google sign-in flow.
      const directState = randomToken(); const directVerifier = randomToken();
      const direct = await handlers.authorize(request(`/api/auth/authorize?app=${app}&state=${directState}&challenge=${hash(directVerifier)}`, cookies(complete)));
      const directCallback = new URL(direct.headers.get("Location")!);
      assert.equal(directCallback.origin + directCallback.pathname, `${config.hub}${mounts[app]}/api/account/callback`);
      assert.equal(store.exchange(app, directCallback.searchParams.get("code")!, directState, directVerifier)?.user.email, identity.email);
    }
  } finally {
    store.close();
    environment.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
