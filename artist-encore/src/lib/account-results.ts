import type {SqlExecutor,SqlStatement} from "@musical-daily/database";
import type {ResultEvent} from "@musical-daily/accounts";
import type {Game} from "./types.ts";
import {finishIncomplete,unfinished} from "./engine.ts";

export function accountResultStatement(game:Game):SqlStatement|null{
  const incomplete=game.completionStatus==="incomplete";
  if(!incomplete&&game.results.length!==10)return null;
  const correct=game.results.filter(result=>result.correct).length;
  const event:ResultEvent={eventId:game.id,mode:"artist",date:new Date(game.completedAt??Date.now()).toISOString().slice(0,10),score:correct,maxScore:10,won:!incomplete&&correct===10,correct,rounds:game.results.length,artist:{id:game.artist.id,name:game.artist.name},status:incomplete?"incomplete":"completed",...(incomplete?{incompleteReason:game.incompleteReason}:{})};
  return {sql:"INSERT OR IGNORE INTO account_result_outbox(game_id,player,event,created_at,last_attempt,synced_at) VALUES(?,?,?,?,0,NULL)",args:[game.id,game.player,JSON.stringify(event),Date.now()]};
}
export async function queueAccountResult(db:SqlExecutor,game:Game){
  const statement=accountResultStatement(game);
  if(statement)await db.execute(statement.sql,statement.args);
}
/** Only called inside a write transaction after OAuth has verified this browser and user. */
export async function claimGuestGames(db:SqlExecutor,guestPlayer:string,userId:string){
  const target=`account:${userId}`;let moved=0;
  if(guestPlayer.startsWith("account:")||guestPlayer===target)return 0;
  const accountGames=(await db.execute("SELECT state FROM games WHERE player=? ORDER BY created_at DESC,id DESC",[target])).rows.map(row=>JSON.parse(String(row.state)) as Game);
  let active=accountGames.find(unfinished);
  // Older versions allowed parallel saved mixes. Keep one authoritative resumable mix.
  for(const game of accountGames){if(game!==active&&unfinished(game)){finishIncomplete(game,"account-merge");await db.execute("UPDATE games SET state=? WHERE id=?",[JSON.stringify(game),game.id]);await queueAccountResult(db,game);}}
  const rows=(await db.execute("SELECT id,state FROM games WHERE player=? ORDER BY created_at DESC,id DESC",[guestPlayer])).rows;
  for(const row of rows){
    const game=JSON.parse(String(row.state)) as Game;
    const collision=(await db.execute("SELECT id FROM games WHERE player=? AND request_id=?",[target,game.requestId])).rows[0];
    if(collision){game.requestId=`claimed-${game.id}`;}
    if(unfinished(game)){if(active)finishIncomplete(game,"account-merge");else active=game;}
    game.player=target;await db.execute("UPDATE games SET player=?,request_id=?,state=? WHERE id=? AND player=?",[target,game.requestId,JSON.stringify(game),game.id,guestPlayer]);await queueAccountResult(db,game);moved++;
  }
  // Retention may remove the detailed mix; its finalized guest event remains claimable.
  await db.execute("UPDATE account_result_outbox SET player=? WHERE player=?",[target,guestPlayer]);
  const exposures=(await db.execute("SELECT artist,track,plays,last_played FROM exposures WHERE player=?",[guestPlayer])).rows;
  if(exposures.length)await db.batch(exposures.map(row=>({sql:"INSERT INTO exposures VALUES(?,?,?,?,?) ON CONFLICT(player,artist,track) DO UPDATE SET plays=plays+excluded.plays,last_played=max(last_played,excluded.last_played)",args:[target,row.artist,row.track,row.plays,row.last_played]})));
  await db.execute("DELETE FROM exposures WHERE player=?",[guestPlayer]);
  return moved;
}
export async function flushAccountResults(db:SqlExecutor,player:string,publish:(events:ResultEvent[])=>Promise<{saved:boolean}>,now=Date.now()){
  if(!player.startsWith("account:"))return true;
  // Claim one retry batch atomically, then release the database before the network call.
  const rows=(await db.execute(`UPDATE account_result_outbox SET last_attempt=? WHERE game_id IN
    (SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL AND last_attempt<? ORDER BY created_at LIMIT 50)
    RETURNING game_id,event`,[now,player,now-5000])).rows;
  if(rows.length){try{const result=await publish(rows.map(row=>JSON.parse(String(row.event))));if(result.saved)await db.batch(rows.map(row=>({sql:"UPDATE account_result_outbox SET synced_at=? WHERE game_id=?",args:[Date.now(),row.game_id]})));}catch{/* Keep the durable outbox for a later authenticated retry. */}}
  return !(await db.execute("SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL LIMIT 1",[player])).rows.length;
}
