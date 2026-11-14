import {databaseFor,openLocalDatabase,type Database,type SqlExecutor,type SqlStatement} from "@musical-daily/database";
import type {Game,Exposure,MixMode} from "./types.ts";
import type {ArtistPool} from "./catalog.ts";
import {createGame,expireGuess,finishIncomplete,unfinished} from "./engine.ts";
import {trackIdentity} from "./rules.ts";
import {accountResultStatement,queueAccountResult} from "./account-results.ts";
import {ensureChoices} from "./choices.ts";

export async function openStore(path?:string):Promise<Database>{
  const db=path===undefined?databaseFor("encore"):openLocalDatabase(path);
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY,player TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(player,request_id));
    CREATE INDEX IF NOT EXISTS games_player ON games(player,created_at DESC);
    CREATE TABLE IF NOT EXISTS exposures(player TEXT NOT NULL,artist TEXT NOT NULL,track TEXT NOT NULL,plays INTEGER NOT NULL,last_played INTEGER NOT NULL,PRIMARY KEY(player,artist,track));
    CREATE TABLE IF NOT EXISTS limits(player TEXT NOT NULL,kind TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(player,kind));
    CREATE TABLE IF NOT EXISTS maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guest_account_claims(guest_player TEXT PRIMARY KEY,user_id TEXT NOT NULL,claimed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_result_outbox(game_id TEXT PRIMARY KEY,player TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL,last_attempt INTEGER NOT NULL,synced_at INTEGER);
    CREATE INDEX IF NOT EXISTS account_result_player ON account_result_outbox(player,synced_at);`);
  return db;
}
const globalStore=globalThis as typeof globalThis&{encoreStore?:Promise<Database>;encorePrune?:ReturnType<typeof pruneStore>;encorePruneAfter?:number};
export async function store(){
  const pending=globalStore.encoreStore??(globalStore.encoreStore=openStore());
  let db:Database;
  try{db=await pending;}catch(error){if(globalStore.encoreStore===pending)globalStore.encoreStore=undefined;throw error;}
  if(Date.now()>=(globalStore.encorePruneAfter??0)){
    const prune=globalStore.encorePrune??(globalStore.encorePrune=pruneStore(db));
    try{const result=await prune;globalStore.encorePruneAfter=Date.now()+(result.hasMore?1000:86400000);}
    catch{globalStore.encorePruneAfter=Date.now()+15000;console.warn("Encore retention deferred; gameplay will retry maintenance shortly.");}
    finally{if(globalStore.encorePrune===prune)globalStore.encorePrune=undefined;}
  }
  return db;
}
export async function pruneStore(db:Database,now=Date.now(),force=false){
  if(!force){
    const last=(await db.execute("SELECT last_run FROM maintenance WHERE key='retention'")).rows[0];
    if(last&&now-Number(last.last_run)<86400000)return {skipped:true,hasMore:false,games:0,exposures:0,limits:0};
  }
  return transaction(db,async tx=>{
    // Check within the write transaction: separate serverless instances may prune together.
    const last=(await tx.execute("SELECT last_run FROM maintenance WHERE key='retention'")).rows[0];
    if(!force&&last&&now-Number(last.last_run)<86400000)return {skipped:true,hasMore:false,games:0,exposures:0,limits:0};
    // Ten games per invocation and one extra row for backlog detection. A large
    // first-day cleanup must not monopolize the remote transaction lease.
    const candidates=(await tx.execute(`SELECT state FROM games WHERE
      (json_extract(state,'$.phase') IN ('complete','discarded') AND coalesce(json_extract(state,'$.completedAt'),created_at)<?)
      OR (json_extract(state,'$.phase') NOT IN ('complete','discarded') AND created_at<?)
      OR id IN (SELECT id FROM (SELECT id,row_number() OVER(PARTITION BY player ORDER BY coalesce(json_extract(state,'$.completedAt'),created_at) DESC,id DESC) AS n FROM games) WHERE n>50)
      ORDER BY created_at,id LIMIT 11`,[now-90*86400000,now-30*86400000])).rows;
    const hasMore=candidates.length>10;
    const games=candidates.slice(0,10).map(row=>JSON.parse(String(row.state)) as Game);
    const writes:SqlStatement[]=[];
    for(const game of games){
      if(unfinished(game))finishIncomplete(game,"expired",now);
      const result=accountResultStatement(game);if(result)writes.push(result);
      writes.push({sql:"DELETE FROM games WHERE id=?",args:[game.id]});
    }
    const housekeepingOffset=writes.length;
    writes.push(
      {sql:"DELETE FROM exposures WHERE last_played<?",args:[now-180*86400000]},
      {sql:"DELETE FROM exposures WHERE rowid IN (SELECT rowid FROM (SELECT rowid,row_number() OVER(PARTITION BY player ORDER BY last_played DESC) AS n FROM exposures) WHERE n>5000)"},
      {sql:"DELETE FROM limits WHERE window<?",args:[now-7*86400000]},
      {sql:"DELETE FROM account_result_outbox WHERE synced_at IS NOT NULL AND synced_at<?",args:[now-90*86400000]},
      {sql:"DELETE FROM account_result_outbox WHERE player NOT LIKE 'account:%' AND created_at<?",args:[now-180*86400000]},
    );
    // Keep the marker overdue until the whole backlog has drained. The next
    // request continues with another short batch instead of waiting a day.
    if(!hasMore)writes.push({sql:"INSERT OR REPLACE INTO maintenance VALUES('retention',?)",args:[now]});
    const results=await tx.batch(writes);
    const [exposures,exposureOverflow,limits]=results.slice(housekeepingOffset);
    return {skipped:false,hasMore,games:games.length,exposures:exposures.rowsAffected+exposureOverflow.rowsAffected,limits:limits.rowsAffected};
  });
}
export function transaction<T>(db:Database,fn:(tx:SqlExecutor)=>Promise<T>){return db.transaction(fn);}
export async function findGame(db:SqlExecutor,player:string,id?:string){
  const row=(id?await db.execute("SELECT state FROM games WHERE player=? AND id=?",[player,id]):await db.execute("SELECT state FROM games WHERE player=? ORDER BY (json_extract(state,'$.phase') NOT IN ('complete','discarded') AND json_array_length(json_extract(state,'$.results'))<10) DESC,created_at DESC,id DESC LIMIT 1",[player])).rows[0];
  return row?JSON.parse(String(row.state)) as Game:null;
}
/** Steady reads need no write lock. Re-read before persisting a migration or timeout. */
export async function readSavedGame(db:Database,player:string,clock:()=>number=Date.now){
  const saved=await findGame(db,player);if(!saved)return null;
  const deadline=saved.guessDeadline,choicesChanged=ensureChoices(saved);
  const expired=expireGuess(saved,clock());
  // Finalized legacy mixes may still need their durable account result queued.
  if(!choicesChanged&&!expired&&saved.guessDeadline===deadline&&saved.results.length!==10&&saved.completionStatus!=="incomplete")return saved;
  return transaction(db,async tx=>{
    const current=await findGame(tx,player);if(!current)return null;
    ensureChoices(current);expireGuess(current,clock());await saveGame(tx,current);return current;
  });
}
export async function saveGame(db:SqlExecutor,game:Game){
  await db.execute("INSERT INTO games VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",[game.id,game.player,game.requestId,game.createdAt,JSON.stringify(game)]);
  await queueAccountResult(db,game);
}
export async function historyFor(db:SqlExecutor,player:string,artist:string):Promise<Exposure[]>{
  return (await db.execute("SELECT track id,plays,last_played lastPlayed FROM exposures WHERE player=? AND artist=?",[player,artist])).rows.map(row=>({id:String(row.id),plays:Number(row.plays),lastPlayed:Number(row.lastPlayed)}));
}
export async function recordMix(db:SqlExecutor,game:Game){
  await db.batch(game.picks.map(pick=>({sql:"INSERT INTO exposures VALUES(?,?,?,1,?) ON CONFLICT(player,artist,track) DO UPDATE SET plays=plays+1,last_played=excluded.last_played",args:[game.player,game.artist.id,trackIdentity(pick.track),game.createdAt]})));
  await saveGame(db,game);
}
/** Provider loading happens before this transaction. A failed selection never discards the saved mix. */
export function startMix(db:Database,player:string,pool:ArtistPool,requestId:string,now=Date.now(),mode:MixMode="ranked"){
  return transaction(db,async tx=>{
    const duplicate=(await tx.execute("SELECT state FROM games WHERE player=? AND request_id=?",[player,requestId])).rows[0];
    if(duplicate){const saved=JSON.parse(String(duplicate.state)) as Game;expireGuess(saved,now);await saveGame(tx,saved);return saved;}
    const created=createGame(player,pool,await historyFor(tx,player,pool.artist.id),requestId,now,mode);
    for(const row of (await tx.execute("SELECT state FROM games WHERE player=? AND json_extract(state,'$.phase') NOT IN ('complete','discarded')",[player])).rows){
      const previous=JSON.parse(String(row.state)) as Game;finishIncomplete(previous,"replaced",now);await saveGame(tx,previous);
    }
    await recordMix(tx,created);return created;
  });
}
/** One atomic upsert enforces the limit across concurrent serverless instances. */
export async function rateLimit(db:SqlExecutor,player:string,kind:string,max:number,period=60000,now=Date.now()){
  const result=await db.execute(`INSERT INTO limits VALUES(?,?,?,1)
    ON CONFLICT(player,kind) DO UPDATE SET
      window=CASE WHEN limits.window<=? THEN excluded.window ELSE limits.window END,
      count=CASE WHEN limits.window<=? THEN 1 ELSE limits.count+1 END
    WHERE limits.window<=? OR limits.count<? RETURNING count`,[player,kind,now,now-period,now-period,now-period,max]);
  if(!result.rows.length)throw Object.assign(new Error("A few too many requests. Give it a minute and try again."),{status:429});
}
