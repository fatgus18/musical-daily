import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const result = value => ({ rows: value.rows.map(row => Object.fromEntries(Object.entries(row))), rowsAffected: value.rowsAffected });
const statements = values => values.map(({ sql, args }) => ({ sql, args: args ? [...args] : [] }));

/** One explicit transaction executor; no implicit globals or retries of committed mutations. */
export function createDatabase(options) {
  let client;
  let closed = false;
  let tail = Promise.resolve();
  const connect = () => {
    if (closed) throw new Error("Database is closed.");
    return client ||= createClient({ ...options, intMode: "number" });
  };
  // This also keeps the local SQLite driver from interleaving statements with
  // an open transaction. Remote instances coordinate through the database lock.
  const exclusive = operation => {
    const work = tail.then(operation);
    tail = work.catch(() => {});
    return work;
  };
  const executor = target => ({
    execute: async (sql, args = []) => result(await target.execute({ sql, args: [...args] })),
    batch: async values => (await target.batch(statements(values))).map(result),
  });
  return {
    execute: (sql, args = []) => exclusive(() => executor(connect()).execute(sql, args)),
    batch: values => exclusive(async () => (await connect().batch(statements(values), "write")).map(result)),
    executeMultiple: sql => exclusive(async () => { await connect().executeMultiple(sql); }),
    transaction: fn => exclusive(async () => {
      const tx = await connect().transaction("write");
      try {
        const value = await fn(executor(tx));
        await tx.commit();
        return value;
      } catch (error) {
        try { await tx.rollback(); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally { tx.close(); }
    }),
    close() { closed = true; client?.close(); },
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
  if (!["encore", "double-drop", "music-cache"].includes(scope)) throw new Error("Unknown database scope.");
  if (databases.has(scope)) return databases.get(scope);
  const prefix = scope === "double-drop" ? "DOUBLE_DROP" : scope === "music-cache" && process.env.MUSIC_CACHE_TURSO_DATABASE_URL ? "MUSIC_CACHE" : "ENCORE";
  const url = process.env[`${prefix}_TURSO_DATABASE_URL`];
  const authToken = process.env[`${prefix}_TURSO_AUTH_TOKEN`];
  let database;
  if (url) {
    if (!/^(?:libsql|https):\/\//.test(url) || !authToken) throw new Error(`Invalid or incomplete ${prefix} database configuration.`);
    database = createDatabase({ url, authToken });
  } else {
    if (process.env.VERCEL === "1") throw new Error(`Missing ${prefix}_TURSO_DATABASE_URL. Connect managed storage before starting this game.`);
    const path = scope === "encore" ? process.env.ENCORE_DB_PATH || "data/encore.sqlite"
      : scope === "double-drop" ? process.env.DOUBLE_DROP_DB_PATH || "data/double-drop.sqlite"
      : process.env.MUSIC_PROVIDER_CACHE_PATH || process.env.ENCORE_CATALOG_CACHE_PATH || "data/runtime/catalog.sqlite";
    database = openLocalDatabase(path);
  }
  databases.set(scope, database);
  return database;
}
