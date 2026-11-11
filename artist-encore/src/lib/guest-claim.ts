import {createHash,randomBytes} from "node:crypto";
import type {Database} from "@musical-daily/database";
import {claimGuestGames} from "./account-results.ts";

const claimable=`EXISTS(SELECT 1 FROM games WHERE player=?)
  OR EXISTS(SELECT 1 FROM exposures WHERE player=?)
  OR EXISTS(SELECT 1 FROM account_result_outbox WHERE player=?)`;

/** The caller must verify the central session before passing its user id. */
export async function claimGuestIdentity(db:Database,token:string|undefined,userId:string){
  if(!token||!/^[a-f0-9]{64}$/.test(token))return undefined;
  const player=createHash("sha256").update(token).digest("hex");
  // Ordinary authenticated requests with an empty guest cookie need no write lock.
  const status=(await db.execute(`SELECT
    EXISTS(SELECT 1 FROM guest_account_claims WHERE guest_player=?) consumed,
    (${claimable}) claimable`,[player,player,player,player])).rows[0];
  if(status.consumed)return randomBytes(32).toString("hex");
  if(!status.claimable)return token;
  const consumed=await db.transaction(async tx=>{
    const inserted=await tx.execute(`INSERT OR IGNORE INTO guest_account_claims(guest_player,user_id,claimed_at)
      SELECT ?,?,? WHERE ${claimable}`,[player,userId,Date.now(),player,player,player]);
    if(inserted.rowsAffected)await claimGuestGames(tx,player,userId);
    return (await tx.execute("SELECT guest_player FROM guest_account_claims WHERE guest_player=?",[player])).rows.length>0;
  });
  // Retire the claimed identity, including collision leftovers. Signed-out play
  // starts a fresh guest history that can later be attached to its own account.
  return consumed?randomBytes(32).toString("hex"):token;
}
