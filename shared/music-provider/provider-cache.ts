import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Disposable metadata, never player saves. Limits apply to bytes as well as keys. */
export class MetadataCache {
  private db: DatabaseSync;
  private maxBytes: number;
  private maxEntries: number;
  private maxEntryBytes: number;
  constructor(path: string, limits: { maxBytes?: number; maxEntries?: number; maxEntryBytes?: number } = {}) {
    this.maxBytes = limits.maxBytes ?? 24 * 1024 * 1024;
    this.maxEntries = limits.maxEntries ?? 500;
    this.maxEntryBytes = limits.maxEntryBytes ?? 4 * 1024 * 1024;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL;");
    // v5 was an unbounded-by-bytes cache. It contains no game history.
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_cache'").get()) {
      this.db.exec("DROP TABLE catalog_cache; VACUUM;");
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=4194304; PRAGMA wal_autocheckpoint=256;
      CREATE TABLE IF NOT EXISTS provider_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL,
        expires INTEGER NOT NULL, stale_until INTEGER NOT NULL, touched INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cache_expiry ON provider_cache(stale_until);
      CREATE TABLE IF NOT EXISTS request_slots (provider TEXT PRIMARY KEY, next_at INTEGER NOT NULL);`);
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    this.db.exec(`PRAGMA max_page_count=${Math.ceil((this.maxBytes * 3 + 8 * 1024 * 1024) / pageSize)}`);
    this.prune();
  }
  get<T>(key: string, allowStale = false, now = Date.now()): { value: T; stale: boolean } | undefined {
    const row = this.db.prepare("SELECT value,expires FROM provider_cache WHERE key=? AND stale_until>?").get(key, now) as { value: string; expires: number } | undefined;
    if (!row || (!allowStale && row.expires <= now)) return undefined;
    try {
      const value = JSON.parse(row.value) as T;
      this.db.prepare("UPDATE provider_cache SET touched=? WHERE key=? AND touched<?").run(now, key, now - 60_000);
      return { value, stale: row.expires <= now };
    } catch { this.db.prepare("DELETE FROM provider_cache WHERE key=?").run(key); return undefined; }
  }
  put(key: string, value: unknown, ttl: number, staleTtl = 7 * 86400_000, now = Date.now()): boolean {
    const json = JSON.stringify(value); const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
    this.db.prepare(`INSERT INTO provider_cache(key,value,bytes,expires,stale_until,touched) VALUES(?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,expires=excluded.expires,stale_until=excluded.stale_until,touched=excluded.touched`)
      .run(key, json, bytes, now + ttl, now + ttl + staleTtl, now);
    this.prune(now);
    return true;
  }
  /** Coordinates provider pacing across workers using this same SQLite file. */
  reserve(provider: string, spacing: number, maxWait: number, now = Date.now()): number | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT next_at FROM request_slots WHERE provider=?").get(provider) as { next_at: number } | undefined;
      const at = Math.max(now, row?.next_at ?? now);
      if (at - now > maxWait) { this.db.exec("ROLLBACK"); return undefined; }
      this.db.prepare("INSERT INTO request_slots(provider,next_at) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET next_at=excluded.next_at").run(provider, at + spacing);
      this.db.exec("COMMIT"); return at - now;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM provider_cache WHERE stale_until<=?").run(now);
    const rows = this.db.prepare("SELECT key,bytes FROM provider_cache ORDER BY touched DESC,key").all() as { key: string; bytes: number }[];
    let total = 0;
    const remove = this.db.prepare("DELETE FROM provider_cache WHERE key=?");
    rows.forEach((row, index) => { total += row.bytes; if (index >= this.maxEntries || total > this.maxBytes) remove.run(row.key); });
    this.db.exec("PRAGMA incremental_vacuum(256); PRAGMA wal_checkpoint(PASSIVE);");
  }
  stats(): { entries: number; bytes: number } { return this.db.prepare("SELECT count(*) entries,coalesce(sum(bytes),0) bytes FROM provider_cache").get() as { entries: number; bytes: number }; }
  close(): void { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}

let shared: MetadataCache | undefined;
let sharedPath: string | undefined;
export function metadataCache(): MetadataCache {
  const path = process.env.MUSIC_PROVIDER_CACHE_PATH || process.env.ENCORE_CATALOG_CACHE_PATH || resolve(process.cwd(), "data/runtime/catalog.sqlite");
  if (shared && sharedPath === path) return shared;
  shared?.close(); sharedPath = path; shared = new MetadataCache(path); return shared;
}
