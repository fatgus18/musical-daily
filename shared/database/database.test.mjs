import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, openLocalDatabase, databaseFor } from "./index.mjs";

test("remote reads use independent HTTP streams instead of a global request queue", async () => {
  let active = 0; let peak = 0; let requests = 0;
  const db = createDatabase({ url: "https://database.example.invalid", authToken: "test-only-token", fetch: async (input, init) => {
    const body = await new Request(input, init).json();
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 40));
    active--;
    return Response.json({ baton: null, base_url: null, results: body.requests.map(request => ({ type: "ok", response: request.type === "execute" ? {
      type: "execute", result: { cols: [{ name: "value", decltype: "INTEGER" }], rows: [[{ type: "integer", value: "1" }]], affected_row_count: 0, last_insert_rowid: null },
    } : { type: request.type } })) });
  } });
  try {
    const values = await Promise.all([db.execute("SELECT 1 AS value"), db.execute("SELECT 1 AS value")]);
    assert.equal(peak, 2, "one remote request must not wait for the other to finish");
    assert.equal(requests, 2);
    assert.deepEqual(values.map(value => value.rows), [[{ value: 1 }], [{ value: 1 }]]);
  } finally { db.close(); }
});

test("transaction executor commits atomically and rolls back failed writes", async () => {
  const db = openLocalDatabase(":memory:");
  try {
    await db.executeMultiple("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await db.transaction(async tx => {
      await tx.execute("INSERT INTO entries VALUES (?,?)", [1, "first"]);
      await tx.batch([{ sql: "INSERT INTO entries VALUES (?,?)", args: [2, "second"] }]);
    });
    await assert.rejects(db.transaction(async tx => {
      await tx.execute("INSERT INTO entries VALUES (?,?)", [3, "rolled back"]);
      throw new Error("Abort this change");
    }), /Abort this change/);
    assert.deepEqual((await db.execute("SELECT id,value FROM entries ORDER BY id")).rows, [{ id: 1, value: "first" }, { id: 2, value: "second" }]);
  } finally { db.close(); }
});

test("concurrent transactions cannot interleave reads and updates on a handle", async () => {
  const db = openLocalDatabase(":memory:");
  try {
    await db.executeMultiple("CREATE TABLE counters (id TEXT PRIMARY KEY, count INTEGER); INSERT INTO counters VALUES ('plays',0)");
    await Promise.all(Array.from({ length: 20 }, () => db.transaction(async tx => {
      const count = (await tx.execute("SELECT count FROM counters WHERE id=?", ["plays"])).rows[0].count;
      await new Promise(resolve => setTimeout(resolve, 1));
      await tx.execute("UPDATE counters SET count=? WHERE id=?", [Number(count) + 1, "plays"]);
    })));
    assert.equal((await db.execute("SELECT count FROM counters")).rows[0].count, 20);
  } finally { db.close(); }
  await assert.rejects(db.execute("SELECT 1"), /closed/);
});

test("a busy error from inside a transaction is rolled back and never replayed", async () => {
  const db = openLocalDatabase(":memory:");
  let calls = 0;
  const failure = Object.assign(new Error("busy after mutation"), { code: "SQLITE_BUSY" });
  try {
    await db.executeMultiple("CREATE TABLE entries (id INTEGER PRIMARY KEY)");
    await assert.rejects(db.transaction(async tx => {
      calls++;
      await tx.execute("INSERT INTO entries VALUES (1)");
      throw failure;
    }), error => error === failure);
    assert.equal(calls, 1);
    assert.equal((await db.execute("SELECT * FROM entries")).rows.length, 0);
  } finally { db.close(); }
});

test("Vercel never silently falls back to local game storage", () => {
  const prior = process.env.VERCEL;
  const url = process.env.DOUBLE_DROP_TURSO_DATABASE_URL;
  process.env.VERCEL = "1";
  delete process.env.DOUBLE_DROP_TURSO_DATABASE_URL;
  try {
    assert.throws(() => openLocalDatabase(":memory:"), /disabled on Vercel/);
    assert.throws(() => databaseFor("double-drop"), /Missing DOUBLE_DROP_TURSO_DATABASE_URL/);
  } finally {
    if (prior === undefined) delete process.env.VERCEL; else process.env.VERCEL = prior;
    if (url === undefined) delete process.env.DOUBLE_DROP_TURSO_DATABASE_URL; else process.env.DOUBLE_DROP_TURSO_DATABASE_URL = url;
  }
});

test("accounts requires its own complete managed connection on Vercel", async () => {
  const keys = ["VERCEL", "ACCOUNTS_TURSO_DATABASE_URL", "ACCOUNTS_TURSO_AUTH_TOKEN", "ENCORE_TURSO_DATABASE_URL", "ENCORE_TURSO_AUTH_TOKEN"];
  const previous = keys.map(key => process.env[key]);
  const { databaseFor: isolatedDatabaseFor } = await import("./index.mjs?accounts-configuration");
  let database;
  try {
    process.env.VERCEL = "1";
    // An Encore binding must never become the accounts database implicitly.
    process.env.ENCORE_TURSO_DATABASE_URL = "libsql://encore.example";
    process.env.ENCORE_TURSO_AUTH_TOKEN = "test-encore-token";
    delete process.env.ACCOUNTS_TURSO_DATABASE_URL;
    delete process.env.ACCOUNTS_TURSO_AUTH_TOKEN;
    assert.throws(() => isolatedDatabaseFor("accounts"), /Missing ACCOUNTS_TURSO_DATABASE_URL/);
    process.env.ACCOUNTS_TURSO_DATABASE_URL = "file:accounts.sqlite";
    process.env.ACCOUNTS_TURSO_AUTH_TOKEN = "test-accounts-token";
    assert.throws(() => isolatedDatabaseFor("accounts"), /Invalid or incomplete ACCOUNTS/);
    process.env.ACCOUNTS_TURSO_DATABASE_URL = "libsql://accounts.example";
    delete process.env.ACCOUNTS_TURSO_AUTH_TOKEN;
    assert.throws(() => isolatedDatabaseFor("accounts"), /Invalid or incomplete ACCOUNTS/);
    process.env.ACCOUNTS_TURSO_AUTH_TOKEN = "test-accounts-token";
    database = isolatedDatabaseFor("accounts");
    assert.equal(isolatedDatabaseFor("accounts"), database);
    // Connections are lazy; configuration tests must not call a real service.
    assert.equal(typeof database.transaction, "function");
  } finally {
    database?.close();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
});
