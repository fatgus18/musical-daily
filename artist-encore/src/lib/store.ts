import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname,resolve} from "node:path";
import type {Game,Exposure,MixMode} from "./types.ts";
import type {ArtistPool} from "./catalog.ts";
import {createGame,expireGuess,finishIncomplete,unfinished} from "./engine.ts";
import {trackIdentity} from "./rules.ts";
import {queueAccountResult} from "./account-results.ts";
export function openStore(path=process.env.ENCORE_DB_PATH||resolve("data/encore.sqlite")){
  if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY,player TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(player,request_id));
    CREATE INDEX IF NOT EXISTS games_player ON games(player,created_at DESC);
    CREATE TABLE IF NOT EXISTS exposures(player TEXT NOT NULL,artist TEXT NOT NULL,track TEXT NOT NULL,plays INTEGER NOT NULL,last_played INTEGER NOT NULL,PRIMARY KEY(player,artist,track));
    CREATE TABLE IF NOT EXISTS limits(player TEXT NOT NULL,kind TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(player,kind));
    CREATE TABLE IF NOT EXISTS maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_result_outbox(game_id TEXT PRIMARY KEY,player TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL,last_attempt INTEGER NOT NULL,synced_at INTEGER);
    CREATE INDEX IF NOT EXISTS account_result_player ON account_result_outbox(player,synced_at);`);
  return db;
}
const globalStore=globalThis as typeof globalThis&{encoreStore?:DatabaseSync};
export const store=()=>{const db=globalStore.encoreStore??(globalStore.encoreStore=openStore());pruneStore(db);return db;};
export function pruneStore(db:DatabaseSync,now=Date.now(),force=false){
  const last=db.prepare("SELECT last_run FROM maintenance WHERE key='retention'").get();if(!force&&last&&now-Number(last.last_run)<86400000)return {skipped:true,games:0,exposures:0,limits:0};
  return transaction(db,()=>{
    const expired=db.prepare("SELECT state FROM games WHERE (json_extract(state,'$.phase') IN ('complete','discarded') AND coalesce(json_extract(state,'$.completedAt'),created_at)<?) OR (json_extract(state,'$.phase') NOT IN ('complete','discarded') AND created_at<?)").all(now-90*86400000,now-30*86400000);
    const remove=(rows:typeof expired)=>{for(const row of rows){const game=JSON.parse(String(row.state)) as Game;if(unfinished(game))finishIncomplete(game,"expired",now);queueAccountResult(db,game);db.prepare("DELETE FROM games WHERE id=?").run(game.id);}return rows.length;};
    const games=remove(expired);
    const overflow=remove(db.prepare("SELECT state FROM (SELECT state,row_number() OVER(PARTITION BY player ORDER BY coalesce(json_extract(state,'$.completedAt'),created_at) DESC,id DESC) AS n FROM games) WHERE n>50").all());
    const exposures=db.prepare("DELETE FROM exposures WHERE last_played<?").run(now-180*86400000).changes;
    const exposureOverflow=db.prepare("DELETE FROM exposures WHERE rowid IN (SELECT rowid FROM (SELECT rowid,row_number() OVER(PARTITION BY player ORDER BY last_played DESC) AS n FROM exposures) WHERE n>5000)").run().changes;
    const limits=db.prepare("DELETE FROM limits WHERE window<?").run(now-7*86400000).changes;
    db.prepare("DELETE FROM account_result_outbox WHERE synced_at IS NOT NULL AND synced_at<?").run(now-90*86400000);
    db.prepare("DELETE FROM account_result_outbox WHERE player NOT LIKE 'account:%' AND created_at<?").run(now-180*86400000);
    db.prepare("INSERT OR REPLACE INTO maintenance VALUES('retention',?)").run(now);
    return {skipped:false,games:Number(games)+Number(overflow),exposures:Number(exposures)+Number(exposureOverflow),limits:Number(limits)};
  });
}
export function transaction<T>(db:DatabaseSync,fn:()=>T){db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}
export function findGame(db:DatabaseSync,player:string,id?:string){const row=id?db.prepare("SELECT state FROM games WHERE player=? AND id=?").get(player,id):db.prepare("SELECT state FROM games WHERE player=? ORDER BY (json_extract(state,'$.phase') NOT IN ('complete','discarded') AND json_array_length(json_extract(state,'$.results'))<10) DESC,created_at DESC,id DESC LIMIT 1").get(player);return row?JSON.parse(String(row.state)) as Game:null;}
export function saveGame(db:DatabaseSync,game:Game){db.prepare("INSERT INTO games VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(game.id,game.player,game.requestId,game.createdAt,JSON.stringify(game));queueAccountResult(db,game);}
export function historyFor(db:DatabaseSync,player:string,artist:string):Exposure[]{return db.prepare("SELECT track id,plays,last_played lastPlayed FROM exposures WHERE player=? AND artist=?").all(player,artist) as unknown as Exposure[];}
export function recordMix(db:DatabaseSync,game:Game){const insert=db.prepare("INSERT INTO exposures VALUES(?,?,?,1,?) ON CONFLICT(player,artist,track) DO UPDATE SET plays=plays+1,last_played=excluded.last_played");for(const pick of game.picks)insert.run(game.player,game.artist.id,trackIdentity(pick.track),game.createdAt);saveGame(db,game);}
/** Provider loading happens before this transaction. A failed selection never discards the saved mix. */
export function startMix(db:DatabaseSync,player:string,pool:ArtistPool,requestId:string,now=Date.now(),mode:MixMode="ranked"){
  return transaction(db,()=>{
    const duplicate=db.prepare("SELECT state FROM games WHERE player=? AND request_id=?").get(player,requestId);
    if(duplicate){const saved=JSON.parse(String(duplicate.state)) as Game;expireGuess(saved,now);saveGame(db,saved);return saved;}
    const created=createGame(player,pool,historyFor(db,player,pool.artist.id),requestId,now,mode);
    for(const row of db.prepare("SELECT state FROM games WHERE player=? AND json_extract(state,'$.phase') NOT IN ('complete','discarded')").all(player)){
      const previous=JSON.parse(String(row.state)) as Game;finishIncomplete(previous,"replaced",now);saveGame(db,previous);
    }
    recordMix(db,created);return created;
  });
}
export function rateLimit(db:DatabaseSync,player:string,kind:string,max:number,period=60000){const now=Date.now();const row=db.prepare("SELECT window,count FROM limits WHERE player=? AND kind=?").get(player,kind);if(row&&now-Number(row.window)<period&&Number(row.count)>=max)throw Object.assign(new Error("A few too many requests. Give it a minute and try again."),{status:429});const valid=row&&now-Number(row.window)<period;db.prepare("INSERT OR REPLACE INTO limits VALUES(?,?,?,?)").run(player,kind,valid?row!.window:now,valid?Number(row!.count)+1:1);}
