import type {DatabaseSync} from "node:sqlite";
import type {ResultEvent} from "@musical-daily/accounts";
import type {Game} from "./types.ts";
import {discardGame,migrateRetiredMetric,settleClock} from "./engine.ts";
import {loadCatalog} from "./catalog.ts";
import {claimPersonalBest,recordFinishedBank} from "./records.ts";

export function queueAccountResult(db:DatabaseSync,game:Game){
  const status=game.completionStatus??"completed";
  if(!game.player.startsWith("account:")||game.phase!=="complete"||(game.answered===0&&status!=="incomplete"))return;
  const incompleteReason=status==="incomplete"?(game.endReason==="expired"||game.endReason==="account-merge"?game.endReason:"discarded"):undefined;
  const event:ResultEvent={eventId:game.id,mode:"practice",date:new Date(game.completedAt||Date.now()).toISOString().slice(0,10),status,...(incompleteReason?{incompleteReason}:{}),score:game.correct,maxScore:game.answered,won:status==="completed"&&game.banked>0,correct:game.correct,rounds:game.answered,bankedPoints:game.banked};
  db.prepare("INSERT OR IGNORE INTO account_result_outbox VALUES(?,?,?,?,0,NULL)").run(game.id,game.player,JSON.stringify(event),Date.now());
}
/** Only invoked after the central OAuth callback has verified this browser and account. */
export function claimGuestGames(db:DatabaseSync,guestPlayer:string,userId:string,now=Date.now()){
  const target=`account:${userId}`;let moved=0;
  const accountActive=Boolean(db.prepare("SELECT id FROM games WHERE player=? AND active=1").get(target));
  for(const row of db.prepare("SELECT id,state FROM games WHERE player=? ORDER BY created_at DESC").all(guestPlayer)){
    const game=JSON.parse(String(row.state)) as Game;
    // UUID request collisions cannot overwrite or steal an existing account's run.
    if(db.prepare("SELECT id FROM games WHERE player=? AND request_id=?").get(target,game.requestId))continue;
    if(game.phase!=="complete"&&(game.metricFilter==="tempo"||game.phase==="guess"&&game.pair.metric==="tempo"))migrateRetiredMetric(game,loadCatalog(game.catalogVersion),()=>loadCatalog(),now);
    settleClock(game,now);
    if(accountActive&&game.phase!=="complete"){
      // Preserve the account's run. A replaced guest pot is never silently banked.
      discardGame(game,"account-merge",now);game.updatedAt=now;game.revision++;
    }
    game.player=target;
    db.prepare("UPDATE games SET player=?,revision=?,active=?,updated_at=?,state=? WHERE id=? AND player=?").run(target,game.revision,game.phase==="complete"?0:1,game.updatedAt,JSON.stringify(game),game.id,guestPlayer);
    queueAccountResult(db,game);recordFinishedBank(db,game);moved++;
  }
  claimPersonalBest(db,guestPlayer,target,now);return moved;
}
export async function flushAccountResults(db:DatabaseSync,player:string,publish:(events:ResultEvent[])=>Promise<{saved:boolean}>,now=Date.now()){
  if(!player.startsWith("account:"))return true;
  // Claim a retry batch atomically. Multiple app processes share the same retry lease.
  const rows=db.prepare("UPDATE account_result_outbox SET last_attempt=? WHERE game_id IN (SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL AND last_attempt<? ORDER BY created_at LIMIT 50) RETURNING game_id,event").all(now,player,now-5000);
  if(rows.length){
    try{const result=await publish(rows.map(row=>JSON.parse(String(row.event))));if(result.saved)for(const row of rows)db.prepare("UPDATE account_result_outbox SET synced_at=? WHERE game_id=?").run(now,row.game_id);}catch{/* The durable outbox survives account service outages and retries on the next visit. */}
  }
  return !db.prepare("SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL LIMIT 1").get(player);
}
