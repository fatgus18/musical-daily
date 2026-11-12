import {databaseFor, type Database, type SqlExecutor} from "@musical-daily/database";
import {loadCatalog, validateCatalog} from "./catalog.ts";
import type {Catalog} from "./catalog-types.ts";

// Artist packs are bounded independently of the much larger bundled library.
const MAX_SNAPSHOT_BYTES=8*1024*1024;
const initialized=new WeakMap<Database,Promise<void>>();
const caches=new WeakMap<Database,Map<string,Catalog>>();
export function initializeCatalogStorage(db:Database):Promise<void>{
  let ready=initialized.get(db);
  if(!ready){
    ready=db.executeMultiple(`CREATE TABLE IF NOT EXISTS catalog_snapshots(version TEXT PRIMARY KEY,payload TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_room_pins(room_code TEXT PRIMARY KEY,version TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS catalog_room_pin_version ON catalog_room_pins(version,expires_at);`).catch(error=>{initialized.delete(db);throw error;});
    initialized.set(db,ready);
  }
  return ready;
}
function remember(db:Database,catalog:Catalog){
  let cache=caches.get(db);if(!cache){cache=new Map();caches.set(db,cache);}
  cache.delete(catalog.version);cache.set(catalog.version,catalog);
  while(cache.size>3)cache.delete(cache.keys().next().value!);
}
function parseSnapshot(payload:unknown,version:string){
  if(typeof payload!=="string"||Buffer.byteLength(payload)>MAX_SNAPSHOT_BYTES)throw new Error("Saved artist collection exceeds its metadata budget.");
  const catalog=JSON.parse(payload) as Catalog;validateCatalog(catalog);
  if(catalog.version!==version)throw new Error("Saved artist collection version mismatch.");
  return catalog;
}
/** Bundled releases stay read-only; discovered artists survive cold starts in managed storage. */
export async function loadSavedCatalog(version?:string,db?:Database):Promise<Catalog>{
  try{return loadCatalog(version);}catch(error){
    if(!version||(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
  }
  const database=db??databaseFor("double-drop");await initializeCatalogStorage(database);
  const cached=caches.get(database)?.get(version);if(cached)return cached;
  const row=(await database.execute("SELECT payload FROM catalog_snapshots WHERE version=?",[version])).rows[0];
  if(!row)throw Object.assign(new Error("The saved artist collection is temporarily unavailable. Reload the artist and retry."),{status:503});
  const catalog=parseSnapshot(row.payload,version);remember(database,catalog);return catalog;
}
export async function persistArtistCatalog(catalog:Catalog,db=databaseFor("double-drop"),now=Date.now()):Promise<Catalog>{
  validateCatalog(catalog);const payload=JSON.stringify(catalog);const bytes=Buffer.byteLength(payload);
  if(bytes>MAX_SNAPSHOT_BYTES)throw Object.assign(new Error("This artist collection exceeds the supported metadata budget."),{status:503});
  const budget=Number(process.env.DOUBLE_DROP_CATALOG_STORAGE_BUDGET_BYTES||256*1024*1024);
  if(!Number.isSafeInteger(budget)||budget<1024*1024)throw new Error("Invalid catalog storage budget.");
  await initializeCatalogStorage(db);
  const saved=await db.transaction(async tx=>{
    const existing=(await tx.execute("SELECT payload FROM catalog_snapshots WHERE version=?",[catalog.version])).rows[0];
    if(existing){await tx.execute("UPDATE catalog_snapshots SET last_used_at=? WHERE version=?",[now,catalog.version]);return parseSnapshot(existing.payload,catalog.version);}
    const used=Number((await tx.execute("SELECT coalesce(sum(bytes),0) AS bytes FROM catalog_snapshots")).rows[0]?.bytes||0);
    if(used+bytes>budget)throw Object.assign(new Error("Artist collection storage is full. Existing collections remain available; maintenance is required."),{status:503});
    await tx.execute("INSERT INTO catalog_snapshots VALUES(?,?,?,?,?)",[catalog.version,payload,bytes,now,now]);return catalog;
  });
  remember(db,saved);return saved;
}
/** A create transaction pins the snapshot before retention can remove an unused pack. */
export async function pinCatalog(db:SqlExecutor,catalog:Catalog,now=Date.now()){
  try{loadCatalog(catalog.version);return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const result=await db.execute("UPDATE catalog_snapshots SET last_used_at=? WHERE version=?",[now,catalog.version]);
  if(!result.rowsAffected)throw Object.assign(new Error("This artist collection expired. Load the artist again to start a run."),{status:503});
}
/** Co-op snapshots remain pinned for the room's lifetime independently of solo runs. */
export async function pinRoomCatalog(db:SqlExecutor,catalog:Catalog,roomCode:string,expiresAt:number,now=Date.now()){
  await pinCatalog(db,catalog,now);
  await db.execute("INSERT INTO catalog_room_pins(room_code,version,expires_at) VALUES(?,?,?) ON CONFLICT(room_code) DO UPDATE SET version=excluded.version,expires_at=excluded.expires_at",[roomCode,catalog.version,expiresAt]);
}
