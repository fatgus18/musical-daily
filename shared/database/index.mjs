import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const result = value => ({ rows: value.rows.map(row => Object.fromEntries(Object.entries(row))), rowsAffected: value.rowsAffected });
const statements = values => values.map(({ sql, args }) => ({ sql, args: args ? [...args] : [] }));
// Native local SQLite clients cannot safely interleave an open write transaction
// with another handle on the same file in one JavaScript process. Remote clients
// use independent HTTP streams and let the managed database coordinate transactions.
const localQueues = new Map();

/** One explicit transaction executor; no implicit globals or retries of committed mutations. */
export function createDatabase(options) {
  let client;
  let closed = false;
  const local = options.url.startsWith("file:");
  const localKey = local && !options.url.includes(":memory:") ? options.url : null;
  const queue = local ? ((localKey && localQueues.get(localKey)) || { tail: Promise.resolve(), handles: 0 }) : null;
  if (queue) queue.handles++;
  if (localKey) localQueues.set(localKey, queue);
  const connect = () => {
    if (closed) throw new Error("Database is closed.");
    return client ||= createClient({ ...options, intMode: "number" });
  };
  const exclusive = operation => {
    // The HTTP driver gives every operation/transaction its own stream. Do not
    // make one player's slow request hold up unrelated remote session reads.
    // Native local SQLite still requires its per-file (or per-memory) queue.
    if (!queue) return Promise.resolve().then(operation);
    const work = queue.tail.then(operation);
    queue.tail = work.catch(() => {});
    return work;
  };
  const executor = target => ({
    execute: async (sql, args = []) => result(await target.execute({ sql, args: [...args] })),
    batch: async values => (await target.batch(statements(values))).map(result),
  });
  const beginTransaction = async () => {
    // Retry only acquiring the lock, before the caller's callback can execute.
    // In particular, never replay a callback, a commit, or an uncertain write.
    for (let attempt = 0; ; attempt++) {
      try { return await connect().transaction("write"); }
      catch (error) {
        if (error?.code !== "SQLITE_BUSY" || attempt >= 7) throw error;
        await delay(Math.min(10 * 2 ** attempt, 200));
      }
    }
  };
  return {
    execute: (sql, args = []) => exclusive(() => executor(connect()).execute(sql, args)),
    batch: values => exclusive(async () => (await connect().batch(statements(values), "write")).map(result)),
    executeMultiple: sql => exclusive(async () => { await connect().executeMultiple(sql); }),
    transaction: fn => exclusive(async () => {
      const tx = await beginTransaction();
      try {
        const value = await fn(executor(tx));
        await tx.commit();
        return value;
      } catch (error) {
        try { await tx.rollback(); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally { tx.close(); }
    }),
    close() {
      if (closed) return;
      closed = true;
      client?.close();
      if (queue) queue.handles--;
      if (localKey && queue) void queue.tail.then(() => {
        if (queue.handles === 0 && localQueues.get(localKey) === queue) localQueues.delete(localKey);
      });
    },
  };
}

export function openLocalDatabase(path) {
  if (process.env.VERCEL === "1") throw new Error("Local databases are disabled on Vercel. Configure the managed database connection.");
  if (path === ":memory:") return createDatabase({ url: "file::memory:" });
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  return createDatabase({ url: pathToFileURL(absolute).href });
}

const databases = new Map();
export function databaseFor(scope) {
  if (!["encore", "double-drop", "music-cache", "accounts"].includes(scope)) throw new Error("Unknown database scope.");
  if (databases.has(scope)) return databases.get(scope);
  const prefix = scope === "accounts" ? "ACCOUNTS" : scope === "double-drop" ? "DOUBLE_DROP" : scope === "music-cache" && process.env.MUSIC_CACHE_TURSO_DATABASE_URL ? "MUSIC_CACHE" : "ENCORE";
  const url = process.env[`${prefix}_TURSO_DATABASE_URL`];
  const authToken = process.env[`${prefix}_TURSO_AUTH_TOKEN`];
  let database;
  if (url) {
    if (!/^(?:libsql|https):\/\//.test(url) || !authToken) throw new Error(`Invalid or incomplete ${prefix} database configuration.`);
    database = createDatabase({ url, authToken });
  } else {
    if (process.env.VERCEL === "1") throw new Error(`Missing ${prefix}_TURSO_DATABASE_URL. Connect managed storage before starting this game.`);
    const path = scope === "accounts" ? process.env.ACCOUNTS_DB_PATH || "data/accounts.sqlite"
      : scope === "encore" ? process.env.ENCORE_DB_PATH || "data/encore.sqlite"
      : scope === "double-drop" ? process.env.DOUBLE_DROP_DB_PATH || "data/double-drop.sqlite"
      : process.env.MUSIC_PROVIDER_CACHE_PATH || process.env.ENCORE_CATALOG_CACHE_PATH || "data/runtime/catalog.sqlite";
    database = openLocalDatabase(path);
  }
  databases.set(scope, database);
  return database;
}
