import { randomUUID } from "node:crypto";
import { databaseFor, openLocalDatabase, type Database } from "@musical-daily/database";

interface Limits { maxBytes?: number; maxEntries?: number; maxEntryBytes?: number }

/** Disposable metadata, never player saves. One remote cache also coordinates provider traffic. */
export class MetadataCache {
  private readonly db: Database;
  private readonly ready: Promise<void>;
  private readonly owned: boolean;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;

  constructor(database: string | Database, limits: Limits = {}) {
    this.maxBytes = limits.maxBytes ?? 24 * 1024 * 1024;
    this.maxEntries = limits.maxEntries ?? 500;
    this.maxEntryBytes = limits.maxEntryBytes ?? 4 * 1024 * 1024;
    for (const value of [this.maxBytes, this.maxEntries, this.maxEntryBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Cache limits must be positive integers.");
    }
    this.owned = typeof database === "string";
    this.db = typeof database === "string" ? openLocalDatabase(database) : database;
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS provider_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL,
        expires INTEGER NOT NULL, stale_until INTEGER NOT NULL, touched INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cache_expiry ON provider_cache(stale_until);
      CREATE TABLE IF NOT EXISTS request_slots (provider TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_cache_leases (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS provider_cache_lease_expiry ON provider_cache_leases(expires);`);
    await this.db.batch(this.pruneStatements(Date.now()));
  }

  async get<T>(key: string, allowStale = false, now = Date.now()): Promise<{ value: T; stale: boolean } | undefined> {
    await this.ready;
    const row = (await this.db.execute("SELECT value,expires FROM provider_cache WHERE key=? AND stale_until>?", [key, now])).rows[0];
    if (!row || (!allowStale && Number(row.expires) <= now)) return undefined;
    let value: T;
    try { value = JSON.parse(String(row.value)) as T; }
    catch {
      // Never delete a concurrent successful refresh while removing a corrupt value.
      await this.db.execute("DELETE FROM provider_cache WHERE key=? AND value=?", [key, row.value]);
      return undefined;
    }
    await this.db.execute("UPDATE provider_cache SET touched=? WHERE key=? AND touched<?", [now, key, now - 60_000]);
    return { value, stale: Number(row.expires) <= now };
  }

  async put(key: string, value: unknown, ttl: number, staleTtl = 7 * 86400_000, now = Date.now()): Promise<boolean> {
    const json = JSON.stringify(value);
    if (json === undefined) return false;
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
    await this.ready;
    // A write batch is atomic across instances: no writer can leave the cache over budget.
    await this.db.batch([
      { sql: `INSERT INTO provider_cache(key,value,bytes,expires,stale_until,touched) VALUES(?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,expires=excluded.expires,stale_until=excluded.stale_until,touched=excluded.touched`,
        args: [key, json, bytes, now + ttl, now + ttl + staleTtl, now] },
      ...this.pruneStatements(now),
    ]);
    return true;
  }

  /** One conditional write reserves a provider slot across all Vercel instances. */
  async reserve(provider: string, spacing: number, maxWait: number, now = Date.now()): Promise<number | undefined> {
    await this.ready;
    const row = (await this.db.execute(`INSERT INTO request_slots(provider,next_at) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET next_at=MAX(request_slots.next_at,?)+?
      WHERE MAX(request_slots.next_at,?)-?<=? RETURNING next_at`,
    [provider, now + spacing, now, spacing, now, now, maxWait])).rows[0];
    return row ? Math.max(0, Number(row.next_at) - spacing - now) : undefined;
  }

  /** Expiring ownership prevents a provider cache miss becoming a cross-instance fetch storm. */
  async acquire(key: string, leaseMs = 120_000, now = Date.now()): Promise<string | undefined> {
    await this.ready;
    const token = randomUUID();
    const results = await this.db.batch([
      { sql: "DELETE FROM provider_cache_leases WHERE expires<=?", args: [now] },
      { sql: `INSERT INTO provider_cache_leases(key,token,expires)
        SELECT ?,?,? WHERE (SELECT count(*) FROM provider_cache_leases)<128
        ON CONFLICT(key) DO NOTHING RETURNING token`, args: [key, token, now + leaseMs] },
    ]);
    return results[1].rows[0] ? token : undefined;
  }

  async release(key: string, token: string): Promise<void> {
    await this.ready;
    await this.db.execute("DELETE FROM provider_cache_leases WHERE key=? AND token=?", [key, token]);
  }

  private pruneStatements(now: number) {
    return [
      { sql: "DELETE FROM provider_cache WHERE stale_until<=?", args: [now] },
      { sql: `DELETE FROM provider_cache WHERE key IN (
        SELECT key FROM (SELECT key,ROW_NUMBER() OVER (ORDER BY touched DESC,key) AS position,
          SUM(bytes) OVER (ORDER BY touched DESC,key ROWS UNBOUNDED PRECEDING) AS total FROM provider_cache)
        WHERE position>? OR total>?)`, args: [this.maxEntries, this.maxBytes] },
      { sql: "DELETE FROM provider_cache_leases WHERE expires<=?", args: [now] },
    ];
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    await this.ready;
    const row = (await this.db.execute("SELECT count(*) entries,coalesce(sum(bytes),0) bytes FROM provider_cache")).rows[0];
    return { entries: Number(row.entries), bytes: Number(row.bytes) };
  }

  async close(): Promise<void> { await this.ready; if (this.owned) this.db.close(); }
}

let shared: MetadataCache | undefined;
let sharedDatabase: Database | string | undefined;
export function metadataCache(): MetadataCache {
  // Explicit paths remain useful for isolated local tests, but never override remote storage on Vercel.
  const localPath = !process.env.VERCEL && (process.env.MUSIC_PROVIDER_CACHE_PATH || process.env.ENCORE_CATALOG_CACHE_PATH);
  const database = localPath || databaseFor("music-cache");
  if (shared && sharedDatabase === database) return shared;
  if (shared) void shared.close().catch(() => undefined);
  sharedDatabase = database;
  shared = new MetadataCache(database);
  return shared;
}

/** Wait briefly for the winner's completed cache value instead of issuing the same upstream request. */
export async function waitForCached<T>(cache: MetadataCache, key: string, maxWait = 20_000): Promise<{ value: T; stale: boolean } | undefined> {
  const deadline = performance.now() + maxWait;
  do {
    const value = await cache.get<T>(key);
    if (value) return value;
    if (performance.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
}
