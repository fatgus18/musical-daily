import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACCOUNT_AVATARS, isAccountAvatar, type AccountAvatar } from "@musical-daily/accounts";
import type { SqlExecutor } from "@musical-daily/database";
import { AccountStore, SESSION_AGE } from "../src/lib/account-store.ts";
import { accountHandlers, createAccountHandlers } from "../src/lib/account-handlers.ts";
import type { AccountConfig } from "../src/lib/account-config.ts";
import type { GoogleProvider } from "../src/lib/google-provider.ts";

const origin = "https://music.example";
const config: AccountConfig = {
  hub: origin, origins: { blackjack: origin, tempo: origin, encore: origin, "double-drop": origin },
  paths: { blackjack: "/blackjack", tempo: "/tempo-trap", encore: "/encore", "double-drop": "/double-or-drop" },
  secret: "avatar-test-secret-with-at-least-32-characters", configured: true,
  clientId: "test-client", clientSecret: "test-client-secret", database: ":memory:",
};
const identity = { sub: "avatar-test-user", name: "Music Fan", email: "fan@example.test", picture: "https://lh3.googleusercontent.com/test-photo" };
const provider: GoogleProvider = { authorization: () => "https://accounts.google.com/", identity: async () => identity };
function fixture(settings = config) {
  let now = Date.parse("2026-11-11T12:00:00Z");
  const store = new AccountStore(":memory:", () => now);
  return { store, handlers: createAccountHandlers(settings, store, provider), advance: (ms: number) => { now += ms; } };
}
function updateRequest(token: string, body: unknown, source: string | null = origin, extra: Record<string, string> = {}) {
  return new Request(`${origin}/api/account/avatar`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: token ? `md_hub_session=${token}` : "", ...(source ? { origin: source } : {}), ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function serviceRequest(body: object, secret = config.secret, source?: string) {
  return new Request(`${origin}/api/account/service`, { method: "POST", headers: { "Content-Type": "application/json", "X-Musical-Daily-Service": secret, ...(source ? { origin: source } : {}) }, body: JSON.stringify(body) });
}

test("all ten music avatars and Default retain the Google photo and leave saved progress and scores intact", async () => {
  const { store, handlers } = fixture();
  try {
    assert.equal(ACCOUNT_AVATARS.length, 10);
    assert.equal(new Set(ACCOUNT_AVATARS.map(avatar => avatar.id)).size, 10);
    assert.ok(Object.isFrozen(ACCOUNT_AVATARS));
    const user = await store.user(identity);
    const session = await store.createSession(user.id, "hub");
    const otherDevice = await store.createSession(user.id, "hub");
    assert.equal(user.avatar, null);
    await store.saveProgress(user.id, "tempo", "daily:2026-11-11", { round: 3 }, 0);
    await store.result(user.id, "tempo", { eventId: "avatar-test-result", mode: "daily", date: "2026-11-11", score: 410, maxScore: 500, rounds: 5, correct: 4, won: true });
    const statsBefore = (await store.stats(user)).games;
    for (const avatar of [...ACCOUNT_AVATARS.map(item => item.id), null]) {
      const response = await handlers.avatar(updateRequest(session.token, { avatar }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const saved = (await response.json()).user;
      assert.equal(saved.avatar, avatar);
      assert.equal(saved.picture, identity.picture);
      assert.equal(saved.id, user.id);
      assert.deepEqual((await store.session(otherDevice.token, "hub"))?.user, saved, "another device sees the account preference");
      assert.deepEqual(await store.sessionProgress(session.token, "hub", "tempo", "daily:2026-11-11"), { user: saved, progress: { value: { round: 3 }, revision: 1 } });
      assert.deepEqual((await store.stats(saved)).games, statsBefore);
    }
  } finally { store.close(); }
});

test("avatar survives storage reopen, Google relogin and an updated Google photo; another account stays separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "musical-daily-avatar-"));
  const path = join(directory, "accounts.sqlite");
  let store = new AccountStore(path);
  try {
    const user = await store.user(identity);
    const session = await store.createSession(user.id, "hub");
    await store.updateAvatar(session.token, "hub", "guitar");
    store.db.close();
    store = new AccountStore(path);
    assert.equal((await store.session(session.token, "hub"))?.user.avatar, "guitar");
    const newPhoto = `${identity.picture}-updated`;
    const relogin = await store.user({ ...identity, picture: newPhoto, name: "New name" });
    assert.equal(relogin.id, user.id);
    assert.equal(relogin.avatar, "guitar");
    assert.equal(relogin.picture, newPhoto);
    const newSession = await store.createSession(relogin.id, "hub");
    assert.equal((await store.session(newSession.token, "hub"))?.user.avatar, "guitar");
    const other = await store.user({ ...identity, sub: "another-google-account" });
    const otherSession = await store.createSession(other.id, "hub");
    assert.equal(other.avatar, null);
    await store.updateAvatar(otherSession.token, "hub", "drums");
    assert.equal((await store.session(newSession.token, "hub"))?.user.avatar, "guitar");
    const reset = await store.updateAvatar(newSession.token, "hub", null);
    assert.equal(reset?.picture, newPhoto);
    assert.equal(reset?.avatar, null);
    assert.equal((await store.session(otherSession.token, "hub"))?.user.avatar, "drums");
  } finally { await store.ready; store.db.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("avatar endpoint rejects cross-origin, guest, revoked, expired and invalid requests without writing preferences", async () => {
  const { store, handlers, advance } = fixture();
  try {
    const user = await store.user(identity);
    const session = await store.createSession(user.id, "hub");
    const other = await store.user({ ...identity, sub: "other-avatar-user" });
    for (const source of [null, "https://evil.example", "null"]) assert.equal((await handlers.avatar(updateRequest(session.token, { avatar: "piano" }, source))).status, 403);
    assert.equal((await handlers.avatar(updateRequest("", { avatar: "piano" }))).status, 401);
    assert.equal((await handlers.avatar(updateRequest("invalid-token", { avatar: "piano" }))).status, 401);
    const invalid = ["not-json", "null", "[]", "{}", { avatar: "unknown" }, { avatar: "🎧" }, { avatar: "default" }, { avatar: 1 }, { avatar: true }, { avatar: {} }, { avatar: "piano", id: other.id }, { avatar: "piano", picture: "https://evil.example" }, `${" ".repeat(1025)}{"avatar":"piano"}`];
    for (const body of invalid) {
      const response = await handlers.avatar(updateRequest(session.token, body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await handlers.avatar(updateRequest(session.token, { avatar: "piano" }, origin, { "Content-Type": "text/plain" }))).status, 400);
    assert.equal((await handlers.avatar(updateRequest(session.token, { avatar: "piano" }, origin, { "Content-Type": "application/jsonp" }))).status, 400);
    assert.equal((await handlers.avatar(updateRequest(session.token, { avatar: "piano" }, origin, { "Content-Length": "10000" }))).status, 400);
    assert.equal(Number((await store.db.execute("SELECT COUNT(*) AS n FROM account_preferences")).rows[0].n), 0);
    await store.revoke(session.family);
    assert.equal((await handlers.avatar(updateRequest(session.token, { avatar: "piano" }))).status, 401);
    const expired = await store.createSession(user.id, "hub");
    advance(SESSION_AGE * 1000);
    assert.equal((await handlers.avatar(updateRequest(expired.token, { avatar: "piano" }))).status, 401);
    assert.equal(Number((await store.db.execute("SELECT COUNT(*) AS n FROM account_preferences")).rows[0].n), 0);
    for (const value of [undefined, "", "unknown", "🎧", "default", 3, {}, null]) assert.equal(isAccountAvatar(value), false);
    await assert.rejects(store.updateAvatar(expired.token, "hub", "not-an-avatar" as AccountAvatar), /Invalid account avatar/);
  } finally { store.close(); }
});

test("internal avatar action preserves service authentication and audience boundaries in both routing modes", async () => {
  for (const settings of [config, { ...config, paths: undefined }]) {
    const { store, handlers } = fixture(settings);
    try {
      const user = await store.user(identity);
      const audience = settings.paths ? "hub" : "encore";
      const session = await store.createSession(user.id, audience);
      const wrong = await store.createSession(user.id, audience === "hub" ? "encore" : "hub");
      const body = { app: "encore", action: "avatar", token: session.token, avatar: "violin" };
      assert.equal((await handlers.service(serviceRequest(body, "wrong-secret"))).status, 401);
      assert.equal((await handlers.service(serviceRequest(body, config.secret, origin))).status, 401);
      assert.equal((await handlers.service(serviceRequest({ ...body, token: wrong.token }))).status, 401);
      assert.equal((await handlers.service(serviceRequest({ ...body, userId: user.id }))).status, 400);
      assert.equal((await handlers.service(serviceRequest({ ...body, avatar: "evil" }))).status, 400);
      assert.equal((await handlers.service(serviceRequest({ app: "encore", action: "avatar", token: session.token }))).status, 400);
      const response = await handlers.service(serviceRequest(body));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).user.avatar, "violin");
      assert.equal((await store.session(session.token, audience))?.user.picture, identity.picture);
      await store.revoke(session.family);
      assert.equal((await handlers.service(serviceRequest({ ...body, avatar: "trumpet" }))).status, 401);
      assert.equal((await store.db.execute("SELECT avatar FROM account_preferences WHERE user_id=?", [user.id])).rows[0].avatar, "violin");
    } finally { store.close(); }
  }
});

test("a development schema upgrade initializes preferences on the existing connection before reading active sessions", async () => {
  const { store } = fixture();
  const shared = globalThis as typeof globalThis & { musicalDailyAccounts?: { path: string; schemaVersion?: number; store: AccountStore } };
  const previousStore = shared.musicalDailyAccounts;
  const keys = ["ACCOUNTS_DB_PATH", "NEXT_PUBLIC_GUEST_ONLY", "ACCOUNTS_TURSO_DATABASE_URL"] as const;
  const previousEnvironment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const user = await store.user(identity);
    const session = await store.createSession(user.id, "hub");
    await store.db.execute("DROP TABLE account_preferences");
    shared.musicalDailyAccounts = { path: ":memory:", store };
    process.env.ACCOUNTS_DB_PATH = ":memory:";
    process.env.NEXT_PUBLIC_GUEST_ONLY = "0";
    delete process.env.ACCOUNTS_TURSO_DATABASE_URL;
    const connection = store.db;
    accountHandlers();
    const initialized = store.ready;
    accountHandlers();
    assert.equal(store.ready, initialized, "migration is scheduled only once");
    assert.equal(shared.musicalDailyAccounts.store, store);
    assert.equal(store.db, connection);
    assert.equal((await store.session(session.token, "hub"))?.user.avatar, null);
    assert.equal((await store.updateAvatar(session.token, "hub", "microphone"))?.avatar, "microphone");
  } finally {
    shared.musicalDailyAccounts = previousStore;
    for (const key of keys) { const value = previousEnvironment[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    store.close();
  }
});

test("avatar writes authenticate inside their transaction and storage outages remain retryable", async context => {
  const { store, handlers } = fixture();
  try {
    const user = await store.user(identity);
    const session = await store.createSession(user.id, "hub");
    const transaction = store.db.transaction.bind(store.db);
    const execute = store.db.execute.bind(store.db);
    const outerReads = context.mock.method(store.db, "execute", execute);
    let reads = 0;
    const transactionMock = context.mock.method(store.db, "transaction", async <T>(callback: (tx: SqlExecutor) => Promise<T>) => transaction(async tx => {
      const scoped = { ...tx, execute: async (sql: string, args?: Parameters<typeof tx.execute>[1]) => { if (sql.startsWith("SELECT")) reads++; return tx.execute(sql, args); } };
      return callback(scoped);
    }));
    assert.equal((await handlers.avatar(updateRequest(session.token, { avatar: "score" }))).status, 200);
    assert.equal(reads, 1, "identity is read within the write transaction");
    assert.equal(outerReads.mock.callCount(), 0, "no stale preliminary identity read");
    transactionMock.mock.restore();
    context.mock.method(store.db, "transaction", async () => { throw new Error("Simulated unavailable database"); });
    const response = await handlers.avatar(updateRequest(session.token, { avatar: "piano" }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match((await response.json()).error, /retry/i);
    assert.equal((await store.session(session.token, "hub"))?.user.avatar, "score");
  } finally { store.close(); }
});
