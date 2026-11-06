import test from "node:test";
import assert from "node:assert/strict";
import { openLocalDatabase, databaseFor } from "./index.mjs";

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
