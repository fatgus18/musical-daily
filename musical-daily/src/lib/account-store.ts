import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AccountUser, AccountStats, GameStats, ResultEvent, GameId, ProgressResult } from "@musical-daily/accounts";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
export const SESSION_AGE = 30 * 86400;
export class AccountValidationError extends Error { constructor(message: string) { super(message); this.name = "AccountValidationError"; } }
export interface Identity { sub: string; email: string; name: string; picture: string | null }
export interface Session { user: AccountUser; family: string; expires: number; app: string }
export interface AuthFlow { browserHash: string; verifier: string; nonce: string; target: { app: GameId; state: string; challenge: string } | null; returnTo: string }
type Row = Record<string, string | number | null>;

export class AccountStore {
  db: DatabaseSync;
  now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,google_sub TEXT UNIQUE NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,picture TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),family TEXT NOT NULL,app TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_family ON sessions(family);
      CREATE TABLE IF NOT EXISTS auth_flows(state_hash TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),family TEXT NOT NULL,app TEXT NOT NULL,state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results(user_id TEXT NOT NULL REFERENCES users(id),game TEXT NOT NULL,event_key TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,game,event_key));
      CREATE TABLE IF NOT EXISTS progress(user_id TEXT NOT NULL REFERENCES users(id),game TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,game,key));
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  prune() { const now = this.now(); this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now); this.db.prepare("DELETE FROM auth_flows WHERE expires<=?").run(now); this.db.prepare("DELETE FROM handoffs WHERE expires<=?").run(now); this.db.prepare("DELETE FROM rate_limits WHERE expires<=?").run(now); this.db.prepare("DELETE FROM progress WHERE updated_at<?").run(now - 90 * 86400000); }
  transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  allow(key: string, limit: number, milliseconds = 600000) { const now = this.now(); const row = this.db.prepare("SELECT count,expires FROM rate_limits WHERE key=?").get(key) as Row | undefined; if (row && Number(row.expires) > now && Number(row.count) >= limit) return false; this.db.prepare("INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END").run(key, now + milliseconds, now, now); return true; }
  user(identity: Identity): AccountUser {
    const row = this.db.prepare("INSERT INTO users(id,google_sub,email,name,picture,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture RETURNING id").get(randomUUID(), identity.sub, identity.email, identity.name, identity.picture, this.now()) as Row;
    const id = String(row.id);
    return { id, email: identity.email, name: identity.name, picture: identity.picture };
  }
  createSession(userId: string, app: string, family: string = randomUUID()) { const token = randomToken(); const existing = this.db.prepare("SELECT MIN(expires) AS expires FROM sessions WHERE family=? AND expires>?").get(family, this.now()) as Row; const expires = Number(existing.expires) || this.now() + SESSION_AGE * 1000; this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(hash(token), userId, family, app, expires); return { token, family, maxAge: Math.max(0, Math.floor((expires - this.now()) / 1000)) }; }
  session(token: string, app?: string): Session | null {
    if (!token || token.length > 200) return null;
    const row = this.db.prepare("SELECT users.id,email,name,picture,family,expires,app FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires>?").get(hash(token), this.now()) as Row | undefined;
    if (!row || (app && row.app !== app)) return null;
    return { user: { id: String(row.id), email: String(row.email), name: String(row.name), picture: row.picture as string | null }, family: String(row.family), expires: Number(row.expires), app: String(row.app) };
  }
  revoke(family: string) { this.db.prepare("DELETE FROM sessions WHERE family=?").run(family); this.db.prepare("DELETE FROM handoffs WHERE family=?").run(family); }
  putFlow(state: string, flow: AuthFlow) { this.db.prepare("INSERT INTO auth_flows VALUES(?,?,?)").run(hash(state), JSON.stringify(flow), this.now() + 600000); }
  takeFlow(state: string, browserToken: string): AuthFlow | null {
    return this.transaction(() => { const row = this.db.prepare("SELECT value FROM auth_flows WHERE state_hash=? AND expires>?").get(hash(state), this.now()) as Row | undefined; if (!row) return null; const flow = JSON.parse(String(row.value)) as AuthFlow; if (hash(browserToken) !== flow.browserHash) return null; this.db.prepare("DELETE FROM auth_flows WHERE state_hash=?").run(hash(state)); return flow; });
  }
  handoff(session: Session, app: GameId, state: string, challenge: string) { const code = randomToken(); this.db.prepare("INSERT INTO handoffs VALUES(?,?,?,?,?,?,?)").run(hash(code), session.user.id, session.family, app, state, challenge, this.now() + 60000); return code; }
  exchange(app: GameId, code: string, state: string, verifier: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM handoffs WHERE code_hash=? AND expires>?").get(hash(code), this.now()) as Row | undefined;
      if (!row || row.app !== app || row.state !== state || row.challenge !== hash(verifier)) return null;
      if (!this.db.prepare("SELECT 1 FROM sessions WHERE family=? AND expires>?").get(row.family, this.now())) return null;
      this.db.prepare("DELETE FROM handoffs WHERE code_hash=?").run(hash(code));
      const result = this.createSession(String(row.user_id), app, String(row.family));
      return { ...result, user: this.session(result.token, app)!.user };
    });
  }
  result(userId: string, game: GameId, event: ResultEvent) {
    validateEvent(game, event);
    const key = event.mode === "daily" ? `daily:${event.date}` : `event:${event.eventId}`;
    const inserted = this.db.prepare("INSERT OR IGNORE INTO results VALUES(?,?,?,?,?)").run(userId, game, key, JSON.stringify(event), this.now()).changes;
    const row = this.db.prepare("SELECT value FROM results WHERE user_id=? AND game=? AND event_key=?").get(userId, game, key) as Row;
    return { saved: true, duplicate: !inserted, event: JSON.parse(String(row.value)) as ResultEvent };
  }
  results(userId: string, game: GameId, events: ResultEvent[]) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 50) throw new AccountValidationError("Expected between one and fifty results");
    events.forEach((event) => validateEvent(game, event));
    return this.transaction(() => { events.forEach((event) => this.result(userId, game, event)); return { saved: true }; });
  }
  loadProgress(userId: string, game: GameId, key: string) { validateKey(key); const row = this.db.prepare("SELECT value,revision FROM progress WHERE user_id=? AND game=? AND key=?").get(userId, game, key) as Row | undefined; return row ? { value: JSON.parse(String(row.value)) as unknown, revision: Number(row.revision) } : null; }
  saveProgress(userId: string, game: GameId, key: string, value: unknown, revision: number, event?: ResultEvent): ProgressResult {
    validateKey(key); if (!Number.isInteger(revision) || revision < 0) throw new AccountValidationError("Invalid progress revision");
    const encoded = JSON.stringify(value); if (!encoded || Buffer.byteLength(encoded) > 131072) throw new AccountValidationError("Progress is too large"); if (event) validateEvent(game, event);
    return this.transaction(() => {
      const current = this.loadProgress(userId, game, key);
      if ((current?.revision || 0) !== revision) return { saved: false, conflict: true, revision: current?.revision || 0, value: current?.value ?? null };
      if (!current) { const count = this.db.prepare("SELECT COUNT(*) AS n FROM progress WHERE user_id=? AND game=?").get(userId, game) as Row; if (Number(count.n) >= 30) this.db.prepare("DELETE FROM progress WHERE rowid IN (SELECT rowid FROM progress WHERE user_id=? AND game=? ORDER BY updated_at LIMIT 1)").run(userId, game); }
      this.db.prepare("INSERT INTO progress VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,game,key) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at").run(userId, game, key, encoded, revision + 1, this.now());
      const result = event ? this.result(userId, game, event) : null;
      return { saved: true, revision: revision + 1, ...(result ? { event: result.event, duplicate: result.duplicate } : {}) };
    });
  }
  stats(user: AccountUser | null): AccountStats {
    const games = Object.fromEntries((["blackjack", "tempo", "encore", "double-drop"] as const).map((game) => {
      const rows = user ? this.db.prepare("SELECT value,created_at FROM results WHERE user_id=? AND game=? ORDER BY created_at DESC").all(user.id, game) as Row[] : [];
      const events = rows.map((row) => ({ event: JSON.parse(String(row.value)) as ResultEvent, date: new Date(Number(row.created_at)).toISOString() }));
      const completed = events.filter(({ event }) => event.status !== "incomplete");
      const total = completed.reduce((sum, { event }) => sum + event.score, 0);
      const streakEvents = completed.filter(({ event }) => game === "encore" || (event.mode === "daily" && (game !== "blackjack" || event.won)));
      const dates = [...new Set(streakEvents.map(({ event, date }) => event.date || date.slice(0, 10)))].sort();
      let bestStreak = 0; let run = 0; let previous = 0;
      for (const date of dates) { const day = Date.parse(date) / 86400000; run = day === previous + 1 ? run + 1 : 1; previous = day; bestStreak = Math.max(bestStreak, run); }
      const today = Math.floor(this.now() / 86400000);
      const lastBlackjack = game === "blackjack" ? completed.filter(({ event }) => event.mode === "daily").sort((a, b) => (b.event.date || "").localeCompare(a.event.date || ""))[0] : null;
      const currentStreak = previous >= today - 1 && (!lastBlackjack || lastBlackjack.event.won) ? run : 0;
      const stats: GameStats = {
        played: events.length,
        completed: completed.length,
        incomplete: events.length - completed.length,
        wins: completed.filter(({ event }) => event.won).length,
        totalScore: total,
        bestScore: completed.reduce((best, { event }) => Math.max(best, event.score), 0),
        averageScore: completed.length ? Math.round(total / completed.length * 10) / 10 : 0,
        averagePercent: completed.length ? Math.round(completed.reduce((sum, { event }) => sum + (event.maxScore ? event.score / event.maxScore * 100 : 0), 0) / completed.length) : 0,
        totalCorrect: events.reduce((sum, { event }) => sum + (event.correct || 0), 0),
        totalRounds: events.reduce((sum, { event }) => sum + (event.rounds || 0), 0),
        currentStreak, bestStreak,
        lastPlayed: events[0]?.date || null,
        recent: events.slice(0, 8).map(({ event, date }) => ({
          eventId: event.eventId, date: event.date || date.slice(0, 10),
          status: event.status || "completed",
          ...(event.incompleteReason ? { incompleteReason: event.incompleteReason } : {}),
          score: event.score, maxScore: event.maxScore,
          ...(event.correct !== undefined ? { correct: event.correct } : {}),
          ...(event.rounds !== undefined ? { rounds: event.rounds } : {}),
          won: event.status !== "incomplete" && (event.won || false),
          ...(event.artist ? { artist: event.artist } : {}),
          ...(game === "double-drop" ? { bankedPoints: event.bankedPoints || 0 } : {}),
        })),
      };
      if (game === "double-drop") {
        // Protected banks survive an abandoned run; unbanked pots never enter an event.
        stats.totalBanked = events.reduce((sum, { event }) => sum + (event.bankedPoints || 0), 0);
        stats.bestBanked = events.reduce((best, { event }) => Math.max(best, event.bankedPoints || 0), 0);
      }
      if (game === "double-drop" || game === "encore") {
        // Count only answered questions, including misses from an incomplete run.
        stats.averagePercent = stats.totalRounds ? Math.round(stats.totalCorrect / stats.totalRounds * 100) : 0;
      }
      return [game, stats];
    })) as AccountStats["games"];
    return { user, games };
  }
}
function validateKey(key: string) { if (typeof key !== "string" || !/^[\w:.-]{1,120}$/.test(key)) throw new AccountValidationError("Invalid progress key"); }
export function validateEvent(game: GameId, event: ResultEvent) {
  if (!event || typeof event.eventId !== "string" || !/^[\w:.-]{1,160}$/.test(event.eventId) || !["daily", "practice", "artist"].includes(event.mode)) throw new AccountValidationError("Invalid result");
  if (event.status !== undefined && event.status !== "completed" && event.status !== "incomplete") throw new AccountValidationError("Invalid result status");
  const incomplete = event.status === "incomplete";
  if (incomplete && (game !== "encore" && game !== "double-drop" || event.mode === "daily" || event.won === true)) throw new AccountValidationError("Invalid incomplete result");
  if (event.incompleteReason !== undefined && (!incomplete || !["discarded", "replaced", "expired", "account-merge"].includes(event.incompleteReason))) throw new AccountValidationError("Invalid incomplete reason");
  const emptyDrop = incomplete && game === "double-drop" && event.rounds === 0 && event.correct === 0;
  if (![event.score, event.maxScore].every(Number.isFinite) || event.maxScore < 0 || (!emptyDrop && event.maxScore === 0) || event.maxScore > 1000000 || event.score < 0 || event.score > event.maxScore) throw new AccountValidationError("Invalid score");
  if (event.mode === "artist" && game !== "encore") throw new AccountValidationError("Invalid game mode");
  if (event.mode === "daily" && (game === "encore" || !/^20\d\d-\d\d-\d\d$/.test(event.date || "") || Number.isNaN(Date.parse(event.date!)) || new Date(event.date!).toISOString().slice(0, 10) !== event.date)) throw new AccountValidationError("Invalid daily result");
  if ((event.correct !== undefined && (!Number.isInteger(event.correct) || event.correct < 0)) || (event.rounds !== undefined && (!Number.isInteger(event.rounds) || event.rounds < (incomplete ? 0 : 1) || event.rounds > (game === "double-drop" ? 1000000 : 1000))) || (event.correct !== undefined && event.correct > (event.rounds || 0))) throw new AccountValidationError("Invalid answer totals");
  if (incomplete && (event.correct === undefined || event.rounds === undefined || event.score !== event.correct)) throw new AccountValidationError("Incomplete results require actual answer totals");
  if (incomplete && game === "encore" && (event.mode !== "artist" || event.maxScore !== 10 || event.rounds! >= 10)) throw new AccountValidationError("Invalid incomplete Encore mix");
  if (event.artist && (game !== "encore" || typeof event.artist.id !== "string" || event.artist.id.length > 100 || typeof event.artist.name !== "string" || event.artist.name.length > 200)) throw new AccountValidationError("Invalid artist");
  if (event.won !== undefined && typeof event.won !== "boolean") throw new AccountValidationError("Invalid win status");
  if (game === "double-drop") {
    if (event.mode !== "practice" || !Number.isInteger(event.score) || !Number.isInteger(event.maxScore) || event.correct !== event.score || event.rounds !== event.maxScore || typeof event.won !== "boolean" || !Number.isSafeInteger(event.bankedPoints) || event.bankedPoints! < 0 || event.bankedPoints! > 1000000000 || (!incomplete && !event.won && event.bankedPoints !== 0) || (event.bankedPoints! > 0 && event.correct === 0) || (event.won && !event.bankedPoints)) throw new AccountValidationError("Invalid Double or Drop result");
  } else if (event.bankedPoints !== undefined) throw new AccountValidationError("Banked points belong to Double or Drop");
  if (Buffer.byteLength(JSON.stringify(event)) > 4096) throw new AccountValidationError("Result is too large");
}
