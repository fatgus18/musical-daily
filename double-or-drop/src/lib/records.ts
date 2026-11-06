import type {Database, SqlExecutor} from "@musical-daily/database";
import type {Game} from "./types.ts";
import {MAX_BANKED_POINTS,MAX_COMPARISONS} from "./rules.ts";

function validBank(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_BANKED_POINTS; }
const KEEP_BANK="INSERT INTO personal_records(player,banked,updated_at) VALUES(?,?,?) ON CONFLICT(player) DO UPDATE SET banked=max(personal_records.banked,excluded.banked),updated_at=max(personal_records.updated_at,excluded.updated_at)";
async function keepBank(db: SqlExecutor, player: string, banked: unknown, now: number) {
  if (validBank(banked)) await db.execute(KEEP_BANK,[player,banked,now]);
}
/** Protected banks from finalized server runs survive detailed-history retention. */
export async function recordFinishedBank(db: SqlExecutor, game: Game) {
  if (game.phase === "complete" && Number.isSafeInteger(game.answered) && game.answered > 0 && game.answered <= MAX_COMPARISONS) await keepBank(db,game.player,game.banked,game.updatedAt);
}
export async function personalBest(db: SqlExecutor, player: string): Promise<number | null> {
  const value=(await db.execute("SELECT banked FROM personal_records WHERE player=?",[player])).rows[0]?.banked;
  return validBank(value)?value:null;
}
/** The caller has already verified account ownership and owns the claim transaction. */
export async function claimPersonalBest(db: SqlExecutor, guest: string, account: string, now: number) {
  await keepBank(db,account,await personalBest(db,guest),now);
  await db.execute("DELETE FROM personal_records WHERE player=?",[guest]);
}
export async function initializeRecords(db: Database) {
  await db.execute("CREATE TABLE IF NOT EXISTS personal_records(player TEXT PRIMARY KEY,banked INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  if ((await db.execute("SELECT last_run FROM maintenance WHERE key='personal-records-v1'")).rows.length) return;
  // Set-based backfill avoids one remote round trip per historical game.
  await db.batch([
    {sql:`INSERT INTO personal_records(player,banked,updated_at)
      SELECT player,max(json_extract(state,'$.banked')),max(updated_at) FROM games
      WHERE active=0 AND json_valid(state) AND json_extract(state,'$.phase')='complete'
        AND json_type(state,'$.answered')='integer' AND json_extract(state,'$.answered') BETWEEN 1 AND ${MAX_COMPARISONS}
        AND json_type(state,'$.banked')='integer' AND json_extract(state,'$.banked') BETWEEN 1 AND ${MAX_BANKED_POINTS}
      GROUP BY player
      ON CONFLICT(player) DO UPDATE SET banked=max(personal_records.banked,excluded.banked),updated_at=max(personal_records.updated_at,excluded.updated_at)`},
    {sql:`INSERT INTO personal_records(player,banked,updated_at)
      SELECT player,max(json_extract(event,'$.bankedPoints')),max(created_at) FROM account_result_outbox
      WHERE json_valid(event) AND json_type(event,'$.rounds')='integer' AND json_extract(event,'$.rounds') BETWEEN 1 AND ${MAX_COMPARISONS}
        AND json_type(event,'$.bankedPoints')='integer' AND json_extract(event,'$.bankedPoints') BETWEEN 1 AND ${MAX_BANKED_POINTS}
      GROUP BY player
      ON CONFLICT(player) DO UPDATE SET banked=max(personal_records.banked,excluded.banked),updated_at=max(personal_records.updated_at,excluded.updated_at)`},
    {sql:"INSERT OR IGNORE INTO maintenance VALUES('personal-records-v1',?)",args:[Date.now()]},
  ]);
}
