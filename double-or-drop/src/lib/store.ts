import {databaseFor,openLocalDatabase,type Database,type SqlExecutor} from "@musical-daily/database";
import type {Game,GameMode,RunHistory} from "./types.ts";
import {queueAccountResult} from "./account-results.ts";
import {discardGame,migrateRetiredMetric,settleClock} from "./engine.ts";
import {loadCatalog} from "./catalog.ts";
import {initializeCatalogStorage} from "./catalog-storage.ts";
import {initializeRecords,recordFinishedBank} from "./records.ts";
import {findDailyGame} from "./daily.ts";

export async function openStore(path?:string):Promise<Database>{
  const db=path===undefined?databaseFor("double-drop"):openLocalDatabase(path);
  await initializeStore(db);return db;
}
export async function initializeStore(db:Database){
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY,player TEXT NOT NULL,request_id TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(player,request_id));
    CREATE INDEX IF NOT EXISTS games_player ON games(player,created_at DESC);
    CREATE TABLE IF NOT EXISTS daily_challenges(date TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS limits(player TEXT NOT NULL,kind TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(player,kind));
    CREATE TABLE IF NOT EXISTS maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guest_account_claims(guest_player TEXT PRIMARY KEY,user_id TEXT NOT NULL,claimed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_result_outbox(game_id TEXT PRIMARY KEY,player TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL,last_attempt INTEGER NOT NULL,synced_at INTEGER);
    CREATE INDEX IF NOT EXISTS account_result_player ON account_result_outbox(player,synced_at);`);
  // Replace the original one-run index atomically: one unlimited and one daily may
  // coexist, but no request race may create another attempt for a UTC date.
  await db.batch([
    {sql:"DROP INDEX IF EXISTS games_one_active"},
    {sql:"CREATE UNIQUE INDEX IF NOT EXISTS games_one_active_mode ON games(player,coalesce(json_extract(state,'$.mode'),'unlimited')) WHERE active=1"},
    {sql:"CREATE UNIQUE INDEX IF NOT EXISTS games_daily_attempt ON games(player,json_extract(state,'$.dailyDate')) WHERE json_extract(state,'$.mode')='daily'"},
  ]);
  await initializeRecords(db);await initializeCatalogStorage(db);
}
const globalStore=globalThis as typeof globalThis&{doubleDropAsyncStore?:Promise<Database>;doubleDropPruning?:Promise<unknown>;doubleDropLastPrune?:number};
export async function store(){
  const db=await(globalStore.doubleDropAsyncStore??=(openStore().catch(error=>{delete globalStore.doubleDropAsyncStore;throw error;})));
  if(!globalStore.doubleDropPruning&&Date.now()-(globalStore.doubleDropLastPrune||0)>300000){
    globalStore.doubleDropPruning=pruneStore(db).then(()=>{globalStore.doubleDropLastPrune=Date.now();}).finally(()=>{delete globalStore.doubleDropPruning;});
  }
  if(globalStore.doubleDropPruning)await globalStore.doubleDropPruning;
  return db;
}
export function transaction<T>(db:Database,fn:(tx:SqlExecutor)=>Promise<T>){return db.transaction(fn);}
export async function findGame(db:SqlExecutor,player:string,id?:string){
  const row=(id?await db.execute("SELECT state FROM games WHERE player=? AND id=?",[player,id]):await db.execute("SELECT state FROM games WHERE player=? ORDER BY active DESC,created_at DESC,id DESC LIMIT 1",[player])).rows[0];
  return row?JSON.parse(String(row.state)) as Game:null;
}
export async function findModeGame(db:SqlExecutor,player:string,mode:GameMode){
  const row=(await db.execute("SELECT state FROM games WHERE player=? AND coalesce(json_extract(state,'$.mode'),'unlimited')=? ORDER BY active DESC,created_at DESC,id DESC LIMIT 1",[player,mode])).rows[0];
  return row?JSON.parse(String(row.state)) as Game:null;
}
export async function findRequest(db:SqlExecutor,player:string,requestId:string){const row=(await db.execute("SELECT state FROM games WHERE player=? AND request_id=?",[player,requestId])).rows[0];return row?JSON.parse(String(row.state)) as Game:null;}
function reconcileSavedGame(game:Game,now:number){
  // Tempo was retired before cloud artist snapshots existed; all legacy versions are bundled.
  if(game.phase!=="complete"&&(game.metricFilter==="tempo"||game.phase==="guess"&&game.pair.metric==="tempo"))migrateRetiredMetric(game,loadCatalog(game.catalogVersion),()=>loadCatalog(),now);
  settleClock(game,now);
}
/** Reads use a fresh snapshot; only migrations and elapsed clocks take the write lock. */
export async function readModeGame(db:Database,player:string,mode:GameMode,date:string,clock:()=>number=Date.now){
  const saved=await findModeGame(db,player,mode),revision=saved?.revision;
  if(saved)reconcileSavedGame(saved,clock());
  if(saved&&saved.revision!==revision)return transaction(db,async tx=>{
    const current=await findModeGame(tx,player,mode);
    await settleSavedGame(tx,current,clock());
    return mode==="daily"?current?.dailyDate===date?current:findDailyGame(tx,player,date):current;
  });
  return mode==="daily"?saved?.dailyDate===date?saved:findDailyGame(db,player,date):saved;
}
/** Caller owns the transaction so timer settlement, personal records and outbox remain atomic. */
export async function settleSavedGame(db:SqlExecutor,game:Game|null,now=Date.now()){
  if(game){
    const revision=game.revision;
    reconcileSavedGame(game,now);
    if(game.revision!==revision)await saveGame(db,game,revision);
  }
  return game;
}
export async function historyFor(db:SqlExecutor,player:string):Promise<RunHistory>{
  const recent=(await db.execute("SELECT state FROM games WHERE player=? ORDER BY created_at DESC,id DESC LIMIT 3",[player])).rows.reverse().map(row=>JSON.parse(String(row.state)) as Game);
  return {recentTracks:recent.flatMap(game=>game.recentTracks).slice(-40),recentPairs:recent.flatMap(game=>game.recentPairs).slice(-40)};
}
export async function saveGame(db:SqlExecutor,game:Game,expectedRevision?:number){
  if(expectedRevision===undefined){await db.execute("INSERT INTO games VALUES(?,?,?,?,?,?,?,?)",[game.id,game.player,game.requestId,game.revision,game.phase==="complete"?0:1,game.createdAt,game.updatedAt,JSON.stringify(game)]);}
  else {
    const changed=await db.execute("UPDATE games SET revision=?,active=?,updated_at=?,state=? WHERE id=? AND player=? AND revision=? AND active=1",[game.revision,game.phase==="complete"?0:1,game.updatedAt,JSON.stringify(game),game.id,game.player,expectedRevision]);
    if(!changed.rowsAffected)throw Object.assign(new Error("This run changed in another tab. Reload to continue."),{status:409});
  }
  await queueAccountResult(db,game);await recordFinishedBank(db,game);
}
export async function rateLimit(db:Database,player:string,kind:string,max:number,period=60000,now=Date.now()){
  const result=await db.execute(`INSERT INTO limits VALUES(?,?,?,1) ON CONFLICT(player,kind) DO UPDATE SET
    window=CASE WHEN ?-limits.window>=? THEN excluded.window ELSE limits.window END,
    count=CASE WHEN ?-limits.window>=? THEN 1 ELSE limits.count+1 END
    WHERE ?-limits.window>=? OR limits.count<? RETURNING count`,[player,kind,now,now,period,now,period,now,period,max]);
  if(!result.rows.length)throw Object.assign(new Error("A few too many requests. Give it a minute and try again."),{status:429});
}
export async function pruneStore(db:Database,now=Date.now(),force=false){
  const last=(await db.execute("SELECT last_run FROM maintenance WHERE key='retention'")).rows[0];
  if(!force&&last&&now-Number(last.last_run)<86400000)return {skipped:true,expired:0,games:0,limits:0,syncedResults:0,catalogs:0};
  // Each abandoned run has its own short write transaction, avoiding remote lease expiry.
  const abandoned=(await db.execute("SELECT id,player FROM games WHERE active=1 AND updated_at<? ORDER BY updated_at LIMIT 10",[now-30*86400000])).rows;
  let expired=0;
  for(const row of abandoned)await db.transaction(async tx=>{
    const game=await findGame(tx,String(row.player),String(row.id));
    if(!game||game.phase==="complete"||game.updatedAt>=now-30*86400000)return;
    const revision=game.revision;
    if(game.metricFilter==="tempo"||game.phase==="guess"&&game.pair.metric==="tempo")migrateRetiredMetric(game,loadCatalog(game.catalogVersion),()=>loadCatalog(),now);
    settleClock(game,now);
    if((game as Game).phase!=="complete"){discardGame(game,"expired",now);game.updatedAt=now;game.revision++;}
    await saveGame(tx,game,revision);expired++;
  });
  const cleanup=await db.batch([
    {sql:"DELETE FROM games WHERE active=0 AND updated_at<?",args:[now-90*86400000]},
    {sql:"DELETE FROM games WHERE id IN (SELECT id FROM (SELECT id,row_number() OVER(PARTITION BY player ORDER BY created_at DESC,id DESC) n FROM games WHERE active=0 AND (json_extract(state,'$.mode') IS NOT 'daily' OR json_extract(state,'$.dailyDate')<date(?/1000,'unixepoch','-2 days'))) WHERE n>50)",args:[now]},
    {sql:"DELETE FROM limits WHERE window<?",args:[now-7*86400000]},
    {sql:"DELETE FROM account_result_outbox WHERE synced_at IS NOT NULL AND synced_at<?",args:[now-90*86400000]},
    {sql:"DELETE FROM catalog_snapshots WHERE last_used_at<? AND NOT EXISTS(SELECT 1 FROM games WHERE json_extract(state,'$.catalogVersion')=catalog_snapshots.version) AND NOT EXISTS(SELECT 1 FROM catalog_room_pins WHERE version=catalog_snapshots.version AND expires_at>?)",args:[now-35*86400000,now]},
    {sql:"INSERT OR REPLACE INTO maintenance VALUES('retention',?)",args:[abandoned.length===10?now-86400000:now]},
    {sql:"DELETE FROM daily_challenges WHERE date<date(?/1000,'unixepoch','-90 days')",args:[now]},
    {sql:"DELETE FROM catalog_room_pins WHERE expires_at<=?",args:[now]},
  ]);
  return {skipped:false,expired,games:cleanup[0].rowsAffected+cleanup[1].rowsAffected,limits:cleanup[2].rowsAffected,syncedResults:cleanup[3].rowsAffected,catalogs:cleanup[4].rowsAffected};
}
