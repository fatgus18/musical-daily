import type {DatabaseSync} from "node:sqlite";
import type {ResultEvent} from "@musical-daily/accounts";
import type {Game} from "./types.ts";
import {finishIncomplete,unfinished} from "./engine.ts";

export function queueAccountResult(db:DatabaseSync,game:Game){
  const incomplete=game.completionStatus==="incomplete";
  if(!incomplete&&game.results.length!==10)return;
  const correct=game.results.filter(result=>result.correct).length;
  const event:ResultEvent={eventId:game.id,mode:"artist",date:new Date(game.completedAt??Date.now()).toISOString().slice(0,10),score:correct,maxScore:10,won:!incomplete&&correct===10,correct,rounds:game.results.length,artist:{id:game.artist.id,name:game.artist.name},status:incomplete?"incomplete":"completed",...(incomplete?{incompleteReason:game.incompleteReason}:{})};
  db.prepare("INSERT OR IGNORE INTO account_result_outbox(game_id,player,event,created_at,last_attempt,synced_at) VALUES(?,?,?,?,0,NULL)").run(game.id,game.player,JSON.stringify(event),Date.now());
}
/** Only called after the shared OAuth callback has verified this browser and user. */
export function claimGuestGames(db:DatabaseSync,guestPlayer:string,userId:string){
  const target=`account:${userId}`;let moved=0;
  if(guestPlayer.startsWith("account:")||guestPlayer===target)return 0;
  const accountGames=db.prepare("SELECT state FROM games WHERE player=? ORDER BY created_at DESC,id DESC").all(target).map(row=>JSON.parse(String(row.state)) as Game);
  let active=accountGames.find(unfinished);
  // Older versions allowed parallel saved mixes. Keep one authoritative resumable mix.
  for(const game of accountGames){if(game!==active&&unfinished(game)){finishIncomplete(game,"account-merge");db.prepare("UPDATE games SET state=? WHERE id=?").run(JSON.stringify(game),game.id);queueAccountResult(db,game);}}
  const rows=db.prepare("SELECT id,state FROM games WHERE player=? ORDER BY created_at DESC,id DESC").all(guestPlayer);
  for(const row of rows){
    const game=JSON.parse(String(row.state)) as Game;
    const collision=db.prepare("SELECT id FROM games WHERE player=? AND request_id=?").get(target,game.requestId);
    if(collision){game.requestId=`claimed-${game.id}`;}
    if(unfinished(game)){if(active)finishIncomplete(game,"account-merge");else active=game;}
    game.player=target;db.prepare("UPDATE games SET player=?,request_id=?,state=? WHERE id=? AND player=?").run(target,game.requestId,JSON.stringify(game),game.id,guestPlayer);queueAccountResult(db,game);moved++;
  }
  // Retention may remove the detailed mix; its finalized guest event remains claimable.
  db.prepare("UPDATE account_result_outbox SET player=? WHERE player=?").run(target,guestPlayer);
  for(const row of db.prepare("SELECT artist,track,plays,last_played FROM exposures WHERE player=?").all(guestPlayer))db.prepare("INSERT INTO exposures VALUES(?,?,?,?,?) ON CONFLICT(player,artist,track) DO UPDATE SET plays=plays+excluded.plays,last_played=max(last_played,excluded.last_played)").run(target,row.artist,row.track,row.plays,row.last_played);
  db.prepare("DELETE FROM exposures WHERE player=?").run(guestPlayer);
  return moved;
}
export async function flushAccountResults(db:DatabaseSync,player:string,publish:(events:ResultEvent[])=>Promise<{saved:boolean}>,now=Date.now()){
  if(!player.startsWith("account:"))return true;
  const rows=db.prepare("SELECT game_id,event FROM account_result_outbox WHERE player=? AND synced_at IS NULL AND last_attempt<? ORDER BY created_at LIMIT 50").all(player,now-5000);
  if(rows.length){for(const row of rows)db.prepare("UPDATE account_result_outbox SET last_attempt=? WHERE game_id=? AND synced_at IS NULL").run(now,row.game_id);try{const result=await publish(rows.map(row=>JSON.parse(String(row.event))));if(result.saved)for(const row of rows)db.prepare("UPDATE account_result_outbox SET synced_at=? WHERE game_id=?").run(Date.now(),row.game_id);}catch{/* Keep the durable outbox for a later authenticated retry. */}}
  return !db.prepare("SELECT game_id FROM account_result_outbox WHERE player=? AND synced_at IS NULL LIMIT 1").get(player);
}
