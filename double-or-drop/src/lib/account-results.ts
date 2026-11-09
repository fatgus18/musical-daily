import type {SqlExecutor} from "@musical-daily/database";
import type {ResultEvent} from "@musical-daily/accounts";
import type {Game} from "./types.ts";
import {discardGame,migrateRetiredMetric,settleClock} from "./engine.ts";
import {loadCatalog} from "./catalog.ts";
import {claimPersonalBest,recordFinishedBank} from "./records.ts";

export async function queueAccountResult(db:SqlExecutor,game:Game){
  const status=game.completionStatus??"completed";
  if(!game.player.startsWith("account:")||game.phase!=="complete"||(game.answered===0&&status!=="incomplete"))return;
  const incompleteReason=status==="incomplete"?(game.endReason==="expired"||game.endReason==="account-merge"?game.endReason:"discarded"):undefined;
  const event:ResultEvent={eventId:game.id,mode:game.mode==="daily"?"daily":"practice",date:game.dailyDate??new Date(game.completedAt||Date.now()).toISOString().slice(0,10),status,...(incompleteReason?{incompleteReason}:{}),score:game.correct,maxScore:game.answered,won:status==="completed"&&game.banked>0,correct:game.correct,rounds:game.answered,bankedPoints:game.banked};
  await db.execute("INSERT OR IGNORE INTO account_result_outbox VALUES(?,?,?,?,0,NULL)",[game.id,game.player,JSON.stringify(event),Date.now()]);
}
/** The verified account callback owns this transaction. */
export async function claimGuestGames(db:SqlExecutor,guestPlayer:string,userId:string,now=Date.now()){
  const target=`account:${userId}`;let moved=0;
  const accountActive=new Set((await db.execute("SELECT coalesce(json_extract(state,'$.mode'),'unlimited') mode FROM games WHERE player=? AND active=1",[target])).rows.map(row=>String(row.mode)));
  const rows=(await db.execute("SELECT id,state FROM games WHERE player=? ORDER BY created_at DESC",[guestPlayer])).rows;
  for(const row of rows){
    const game=JSON.parse(String(row.state)) as Game;
    if(game.mode==="daily"&&(await db.execute("SELECT id FROM games WHERE player=? AND json_extract(state,'$.mode')='daily' AND json_extract(state,'$.dailyDate')=?",[target,game.dailyDate!])).rows.length)continue;
    // Request collisions cannot overwrite or steal another account's run.
    if((await db.execute("SELECT id FROM games WHERE player=? AND request_id=?",[target,game.requestId])).rows.length)continue;
    if(game.phase!=="complete"&&(game.metricFilter==="tempo"||game.phase==="guess"&&game.pair.metric==="tempo"))migrateRetiredMetric(game,loadCatalog(game.catalogVersion),()=>loadCatalog(),now);
    settleClock(game,now);
    if(accountActive.has(game.mode??"unlimited")&&game.phase!=="complete"){
      discardGame(game,"account-merge",now);game.updatedAt=now;game.revision++;
    }
    game.player=target;
    await db.execute("UPDATE games SET player=?,revision=?,active=?,updated_at=?,state=? WHERE id=? AND player=?",[target,game.revision,game.phase==="complete"?0:1,game.updatedAt,JSON.stringify(game),game.id,guestPlayer]);
    await queueAccountResult(db,game);await recordFinishedBank(db,game);moved++;
    if(game.phase!=="complete")accountActive.add(game.mode??"unlimited");
  }
  await claimPersonalBest(db,guestPlayer,target,now);return moved;
}
export async function flushAccountResults(db:SqlExecutor,player:string,publish:(events:ResultEvent[])=>Promise<{saved:boolean}>,now=Date.now()){
  if(!player.startsWith("account:"))return true;
  // One SQL statement leases the batch across concurrent function instances.
  const rows=(await db.execute("UPDATE account_result_outbox SET last_attempt=? WHERE game_id IN (SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL AND last_attempt<? ORDER BY created_at LIMIT 50) RETURNING game_id,event",[now,player,now-5000])).rows;
  if(rows.length){
    try{const result=await publish(rows.map(row=>JSON.parse(String(row.event))));if(result.saved)await db.batch(rows.map(row=>({sql:"UPDATE account_result_outbox SET synced_at=? WHERE game_id=?",args:[now,row.game_id]})));}catch{/* Durable retries survive an unavailable account service. */}
  }
  return !(await db.execute("SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL LIMIT 1",[player])).rows.length;
}
