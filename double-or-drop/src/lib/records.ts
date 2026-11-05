import type {DatabaseSync} from "node:sqlite";
import type {Game} from "./types.ts";
import {MAX_BANKED_POINTS,MAX_COMPARISONS} from "./rules.ts";

function validBank(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_BANKED_POINTS; }
function keepBank(db: DatabaseSync, player: string, banked: unknown, now: number) {
  if (!validBank(banked)) return;
  db.prepare("INSERT INTO personal_records(player,banked,updated_at) VALUES(?,?,?) ON CONFLICT(player) DO UPDATE SET banked=max(personal_records.banked,excluded.banked),updated_at=max(personal_records.updated_at,excluded.updated_at)").run(player, banked, now);
}
/** Protected banks from finalized server runs survive detailed-history retention. */
export function recordFinishedBank(db: DatabaseSync, game: Game) {
  if (game.phase === "complete" && Number.isSafeInteger(game.answered) && game.answered > 0 && game.answered <= MAX_COMPARISONS) keepBank(db, game.player, game.banked, game.updatedAt);
}
export function personalBest(db: DatabaseSync, player: string): number | null {
  const value = db.prepare("SELECT banked FROM personal_records WHERE player=?").get(player)?.banked;
  return validBank(value) ? value : null;
}
/** The caller has already verified account ownership and owns the claim transaction. */
export function claimPersonalBest(db: DatabaseSync, guest: string, account: string, now: number) {
  keepBank(db, account, personalBest(db, guest), now);
  db.prepare("DELETE FROM personal_records WHERE player=?").run(guest);
}
export function initializeRecords(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS personal_records(player TEXT PRIMARY KEY,banked INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  if (db.prepare("SELECT last_run FROM maintenance WHERE key='personal-records-v1'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of db.prepare("SELECT state FROM games WHERE active=0").all()) {
      try { recordFinishedBank(db, JSON.parse(String(row.state)) as Game); } catch { /* A malformed historical row cannot invent a record. */ }
    }
    for (const row of db.prepare("SELECT player,event,created_at FROM account_result_outbox").all()) {
      try { const event = JSON.parse(String(row.event)); if (Number.isSafeInteger(event.rounds) && event.rounds > 0 && event.rounds <= MAX_COMPARISONS) keepBank(db, String(row.player), event.bankedPoints, Number(row.created_at)); } catch { /* Ignore malformed legacy payloads. */ }
    }
    db.prepare("INSERT OR REPLACE INTO maintenance VALUES('personal-records-v1',?)").run(Date.now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
