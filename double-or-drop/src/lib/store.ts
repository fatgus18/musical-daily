import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname,resolve} from "node:path";
import type {Game,RunHistory} from "./types.ts";
import {queueAccountResult} from "./account-results.ts";
import {discardGame,migrateRetiredMetric,settleClock} from "./engine.ts";
import {loadCatalog} from "./catalog.ts";
import {initializeRecords,recordFinishedBank} from "./records.ts";

export function openStore(path=process.env.DOUBLE_DROP_DB_PATH||resolve("data/double-drop.sqlite")){
  if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY,player TEXT NOT NULL,request_id TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(player,request_id));
    CREATE INDEX IF NOT EXISTS games_player ON games(player,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS games_one_active ON games(player) WHERE active=1;
    CREATE TABLE IF NOT EXISTS limits(player TEXT NOT NULL,kind TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(player,kind));
    CREATE TABLE IF NOT EXISTS maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_result_outbox(game_id TEXT PRIMARY KEY,player TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL,last_attempt INTEGER NOT NULL,synced_at INTEGER);
    CREATE INDEX IF NOT EXISTS account_result_player ON account_result_outbox(player,synced_at);`);
  initializeRecords(db);return db;
}
const globalStore=globalThis as typeof globalThis&{doubleDropStore?:DatabaseSync};
export function store(){const db=globalStore.doubleDropStore??(globalStore.doubleDropStore=openStore());initializeRecords(db);pruneStore(db);return db;}
export function transaction<T>(db:DatabaseSync,fn:()=>T){db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}}
export function findGame(db:DatabaseSync,player:string,id?:string){
  const row=id?db.prepare("SELECT state FROM games WHERE player=? AND id=?").get(player,id):db.prepare("SELECT state FROM games WHERE player=? ORDER BY active DESC,created_at DESC,id DESC LIMIT 1").get(player);
  return row?JSON.parse(String(row.state)) as Game:null;
}
export function findRequest(db:DatabaseSync,player:string,requestId:string){const row=db.prepare("SELECT state FROM games WHERE player=? AND request_id=?").get(player,requestId);return row?JSON.parse(String(row.state)) as Game:null;}
/** Caller owns the write transaction, keeping deadline settlement and result outbox atomic. */
export function settleSavedGame(db:DatabaseSync,game:Game|null,now=Date.now()){
  if(game){
    const revision=game.revision;
    // Retire unanswerable tempo questions before settling their old timer.
    if(game.phase!=="complete"&&(game.metricFilter==="tempo"||game.phase==="guess"&&game.pair.metric==="tempo"))migrateRetiredMetric(game,loadCatalog(game.catalogVersion),()=>loadCatalog(),now);
    settleClock(game,now);
    if(game.revision!==revision)saveGame(db,game,revision);
  }
  return game;
}
export function historyFor(db:DatabaseSync,player:string):RunHistory{
  const recent=db.prepare("SELECT state FROM games WHERE player=? ORDER BY created_at DESC,id DESC LIMIT 3").all(player).reverse().map(row=>JSON.parse(String(row.state)) as Game);
  return {recentTracks:recent.flatMap(game=>game.recentTracks).slice(-40),recentPairs:recent.flatMap(game=>game.recentPairs).slice(-40)};
}
export function saveGame(db:DatabaseSync,game:Game,expectedRevision?:number){
  if(expectedRevision===undefined){db.prepare("INSERT INTO games VALUES(?,?,?,?,?,?,?,?)").run(game.id,game.player,game.requestId,game.revision,game.phase==="complete"?0:1,game.createdAt,game.updatedAt,JSON.stringify(game));}
  else {
    const changed=db.prepare("UPDATE games SET revision=?,active=?,updated_at=?,state=? WHERE id=? AND player=? AND revision=? AND active=1").run(game.revision,game.phase==="complete"?0:1,game.updatedAt,JSON.stringify(game),game.id,game.player,expectedRevision);
    if(!changed.changes)throw Object.assign(new Error("This run changed in another tab. Reload to continue."),{status:409});
  }
  queueAccountResult(db,game);
  recordFinishedBank(db,game);
}
export function rateLimit(db:DatabaseSync,player:string,kind:string,max:number,period=60000,now=Date.now()){
  return transaction(db,()=>{const row=db.prepare("SELECT window,count FROM limits WHERE player=? AND kind=?").get(player,kind);const valid=row&&now-Number(row.window)<period;
    if(valid&&Number(row.count)>=max)throw Object.assign(new Error("A few too many requests. Give it a minute and try again."),{status:429});
    db.prepare("INSERT OR REPLACE INTO limits VALUES(?,?,?,?)").run(player,kind,valid?row!.window:now,valid?Number(row!.count)+1:1);
  });
}
export function pruneStore(db:DatabaseSync,now=Date.now(),force=false){
  const last=db.prepare("SELECT last_run FROM maintenance WHERE key='retention'").get();
  if(!force&&last&&now-Number(last.last_run)<86400000)return {skipped:true,expired:0,games:0,limits:0,syncedResults:0};
  return transaction(db,()=>{
    // A month without a move ends abandoned runs. Unbanked risks are never auto-cashed out.
    const abandoned=db.prepare("SELECT state FROM games WHERE active=1 AND updated_at<?").all(now-30*86400000);
    for(const row of abandoned){
      const game=JSON.parse(String(row.state)) as Game,revision=game.revision;
      if(game.metricFilter==="tempo"||game.phase==="guess"&&game.pair.metric==="tempo")migrateRetiredMetric(game,loadCatalog(game.catalogVersion),()=>loadCatalog(),now);
      settleClock(game,now);
      if(game.phase!=="complete"){discardGame(game,"expired",now);game.updatedAt=now;game.revision++;}
      saveGame(db,game,revision);
    }
    const oldGames=db.prepare("DELETE FROM games WHERE active=0 AND updated_at<?").run(now-90*86400000).changes;
    const excessGames=db.prepare("DELETE FROM games WHERE id IN (SELECT id FROM (SELECT id,row_number() OVER(PARTITION BY player ORDER BY created_at DESC,id DESC) n FROM games WHERE active=0) WHERE n>50)").run().changes;
    const limits=db.prepare("DELETE FROM limits WHERE window<?").run(now-7*86400000).changes;
    const syncedResults=db.prepare("DELETE FROM account_result_outbox WHERE synced_at IS NOT NULL AND synced_at<?").run(now-90*86400000).changes;
    db.prepare("INSERT OR REPLACE INTO maintenance VALUES('retention',?)").run(now);
    return {skipped:false,expired:abandoned.length,games:Number(oldGames)+Number(excessGames),limits:Number(limits),syncedResults:Number(syncedResults)};
  });
}
