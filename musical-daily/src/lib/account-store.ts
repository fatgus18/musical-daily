import { openLocalDatabase, type Database, type SqlExecutor } from "@musical-daily/database";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isAccountAvatar, type AccountAvatar, type AccountUser, type AccountStats, type GameStats, type ResultEvent, type GameId, type ProgressResult, type ProgressSnapshot } from "@musical-daily/accounts";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
export const SESSION_AGE = 30 * 86400;
export const ACCOUNT_PREFERENCES_SCHEMA = "CREATE TABLE IF NOT EXISTS account_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),avatar TEXT,updated_at INTEGER NOT NULL);";
export class AccountValidationError extends Error { constructor(message: string) { super(message); this.name = "AccountValidationError"; } }
export interface Identity { sub: string; email: string; name: string; picture: string | null }
export interface Session { user: AccountUser; family: string; expires: number; app: string }
export interface AuthFlow { browserHash: string; verifier: string; nonce: string; target: { app: GameId; state: string; challenge: string } | null; returnTo: string }
export class AccountStore {
  db: Database;
  ready: Promise<void>;
  now: () => number;
  constructor(path: string | Database, now: () => number = Date.now) {
    this.now = now;
    this.db = typeof path === "string" ? openLocalDatabase(path) : path;
    // Shared managed storage is initialized once per instance. Every operation
    // awaits this promise before touching tables, including concurrent requests.
    this.ready = this.db.executeMultiple(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,google_sub TEXT UNIQUE NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,picture TEXT,created_at INTEGER NOT NULL);
      ${ACCOUNT_PREFERENCES_SCHEMA}
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),family TEXT NOT NULL,app TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_family ON sessions(family);
      CREATE TABLE IF NOT EXISTS auth_flows(state_hash TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),family TEXT NOT NULL,app TEXT NOT NULL,state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results(user_id TEXT NOT NULL REFERENCES users(id),game TEXT NOT NULL,event_key TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,game,event_key));
      CREATE TABLE IF NOT EXISTS progress(user_id TEXT NOT NULL REFERENCES users(id),game TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,game,key));
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
    // Keep the original rejected promise observable by callers while preventing
    // an idle, newly-created instance from causing an unhandled rejection.
    void this.ready.catch(() => {});
  }
  close() { void this.ready.then(() => this.db.close(), () => this.db.close()); }
  async prune() {
    await this.ready;
    const now = this.now();
    await this.db.batch([
      { sql: "DELETE FROM sessions WHERE expires<=?", args: [now] },
      { sql: "DELETE FROM auth_flows WHERE expires<=?", args: [now] },
      { sql: "DELETE FROM handoffs WHERE expires<=?", args: [now] },
      { sql: "DELETE FROM rate_limits WHERE expires<=?", args: [now] },
      { sql: "DELETE FROM progress WHERE updated_at<?", args: [now - 90 * 86400000] },
    ]);
  }
  private async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.ready;
    return this.db.transaction(fn);
  }
  async allow(key: string, limit: number, milliseconds = 600000) {
    await this.ready;
    const now = this.now();
    // The conditional upsert is a single atomic write across serverless instances.
    const result = await this.db.execute(`INSERT INTO rate_limits VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
      WHERE expires<=? OR count<? RETURNING count`, [key, now + milliseconds, now, now, now, limit]);
    return result.rows.length > 0;
  }
  async user(identity: Identity): Promise<AccountUser> {
    await this.ready;
    const row = (await this.db.execute("INSERT INTO users(id,google_sub,email,name,picture,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture RETURNING id", [randomUUID(), identity.sub, identity.email, identity.name, identity.picture, this.now()])).rows[0];
    const id = String(row.id);
    const preferences = (await this.db.execute("SELECT avatar FROM account_preferences WHERE user_id=?", [id])).rows[0];
    return { id, email: identity.email, name: identity.name, picture: identity.picture, avatar: isAccountAvatar(preferences?.avatar) ? preferences.avatar : null };
  }
  async createSession(userId: string, app: string, family: string = randomUUID()) {
    return this.transaction(tx => this.createSessionWith(tx, userId, app, family));
  }
  private async createSessionWith(tx: SqlExecutor, userId: string, app: string, family: string) {
    const token = randomToken();
    const now = this.now();
    const existing = (await tx.execute("SELECT MIN(expires) AS expires FROM sessions WHERE family=? AND user_id=? AND expires>?", [family, userId, now])).rows[0];
    const expires = Number(existing.expires) || now + SESSION_AGE * 1000;
    await tx.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", [hash(token), userId, family, app, expires]);
    return { token, family, maxAge: Math.max(0, Math.floor((expires - now) / 1000)) };
  }
  async session(token: string, app?: string): Promise<Session | null> {
    await this.ready;
    return this.sessionWith(this.db, token, app);
  }
  async sessionProgress(token: string, audience: string, game: GameId, key: string): Promise<{ user: AccountUser | null; progress: ProgressSnapshot | null }> {
    validateKey(key);
    if (!token || token.length > 200) return { user: null, progress: null };
    await this.ready;
    // One indexed read authenticates the current session and loads only its
    // owner's game progress. LEFT JOIN preserves valid accounts with no save.
    // Revocation and expiry are checked in SQL on every request, without a TTL.
    const row = (await this.db.execute(`SELECT users.id,users.email,users.name,users.picture,account_preferences.avatar,
      progress.value AS progress_value,progress.revision AS progress_revision
      FROM sessions JOIN users ON users.id=sessions.user_id
      LEFT JOIN progress ON progress.user_id=sessions.user_id AND progress.game=? AND progress.key=?
      LEFT JOIN account_preferences ON account_preferences.user_id=sessions.user_id
      WHERE sessions.token_hash=? AND sessions.app=? AND sessions.expires>?`,
    [game, key, hash(token), audience, this.now()])).rows[0];
    if (!row) return { user: null, progress: null };
    return {
      user: { id: String(row.id), email: String(row.email), name: String(row.name), picture: row.picture as string | null, avatar: isAccountAvatar(row.avatar) ? row.avatar : null },
      progress: row.progress_revision === null ? null : { value: JSON.parse(String(row.progress_value)) as unknown, revision: Number(row.progress_revision) },
    };
  }
  private async sessionWith(tx: SqlExecutor, token: string, app?: string): Promise<Session | null> {
    if (!token || token.length > 200) return null;
    const row = (await tx.execute("SELECT users.id,email,name,picture,account_preferences.avatar,family,expires,app FROM sessions JOIN users ON users.id=sessions.user_id LEFT JOIN account_preferences ON account_preferences.user_id=sessions.user_id WHERE token_hash=? AND expires>?", [hash(token), this.now()])).rows[0];
    if (!row || (app && row.app !== app)) return null;
    return { user: { id: String(row.id), email: String(row.email), name: String(row.name), picture: row.picture as string | null, avatar: isAccountAvatar(row.avatar) ? row.avatar : null }, family: String(row.family), expires: Number(row.expires), app: String(row.app) };
  }
  async updateAvatar(token: string, audience: string, avatar: AccountAvatar | null): Promise<AccountUser | null> {
    if (avatar !== null && !isAccountAvatar(avatar)) throw new AccountValidationError("Invalid account avatar");
    if (!token || token.length > 200) return null;
    return this.transaction(async tx => {
      // Authenticate inside the write transaction so a revoked or expired token
      // cannot update preferences using an earlier, stale identity read.
      const session = await this.sessionWith(tx, token, audience);
      if (!session) return null;
      await tx.execute("INSERT INTO account_preferences(user_id,avatar,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET avatar=excluded.avatar,updated_at=excluded.updated_at", [session.user.id, avatar, this.now()]);
      return { ...session.user, avatar };
    });
  }
  async revoke(family: string) {
    await this.ready;
    await this.db.batch([
      { sql: "DELETE FROM sessions WHERE family=?", args: [family] },
      { sql: "DELETE FROM handoffs WHERE family=?", args: [family] },
    ]);
  }
  async putFlow(state: string, flow: AuthFlow) {
    await this.ready;
    await this.db.execute("INSERT INTO auth_flows VALUES(?,?,?)", [hash(state), JSON.stringify(flow), this.now() + 600000]);
  }
  async takeFlow(state: string, browserToken: string): Promise<AuthFlow | null> {
    return this.transaction(async tx => {
      const row = (await tx.execute("SELECT value FROM auth_flows WHERE state_hash=? AND expires>?", [hash(state), this.now()])).rows[0];
      if (!row) return null;
      const flow = JSON.parse(String(row.value)) as AuthFlow;
      if (hash(browserToken) !== flow.browserHash) return null;
      await tx.execute("DELETE FROM auth_flows WHERE state_hash=?", [hash(state)]);
      return flow;
    });
  }
  async handoff(session: Session, app: GameId, state: string, challenge: string) {
    return this.transaction(async tx => {
      // A session read before a simultaneous logout must not mint a new code.
      const active = (await tx.execute("SELECT 1 FROM sessions WHERE family=? AND user_id=? AND expires>? LIMIT 1", [session.family, session.user.id, this.now()])).rows[0];
      if (!active || session.expires <= this.now()) throw new AccountValidationError("This session has expired");
      const code = randomToken();
      await tx.execute("INSERT INTO handoffs VALUES(?,?,?,?,?,?,?)", [hash(code), session.user.id, session.family, app, state, challenge, Math.min(session.expires, this.now() + 60000)]);
      return code;
    });
  }
  async exchange(app: GameId, code: string, state: string, verifier: string) {
    return this.transaction(async tx => {
      const row = (await tx.execute("SELECT * FROM handoffs WHERE code_hash=? AND expires>?", [hash(code), this.now()])).rows[0];
      if (!row || row.app !== app || row.state !== state || row.challenge !== hash(verifier)) return null;
      if (!(await tx.execute("SELECT 1 FROM sessions WHERE family=? AND user_id=? AND expires>? LIMIT 1", [row.family, row.user_id, this.now()])).rows[0]) return null;
      await tx.execute("DELETE FROM handoffs WHERE code_hash=?", [hash(code)]);
      const result = await this.createSessionWith(tx, String(row.user_id), app, String(row.family));
      return { ...result, user: (await this.sessionWith(tx, result.token, app))!.user };
    });
  }
  async result(userId: string, game: GameId, event: ResultEvent) {
    validateEvent(game, event);
    return this.transaction(tx => this.resultWith(tx, userId, game, event));
  }
  private async resultWith(tx: SqlExecutor, userId: string, game: GameId, event: ResultEvent) {
    const key = event.mode === "daily" ? `daily:${event.date}` : `event:${event.eventId}`;
    const inserted = (await tx.execute("INSERT OR IGNORE INTO results VALUES(?,?,?,?,?)", [userId, game, key, JSON.stringify(event), this.now()])).rowsAffected;
    const row = (await tx.execute("SELECT value FROM results WHERE user_id=? AND game=? AND event_key=?", [userId, game, key])).rows[0];
    return { saved: true, duplicate: !inserted, event: JSON.parse(String(row.value)) as ResultEvent };
  }
  async results(userId: string, game: GameId, events: ResultEvent[]) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 50) throw new AccountValidationError("Expected between one and fifty results");
    events.forEach((event) => validateEvent(game, event));
    await this.ready;
    // One managed batch is atomic and avoids a network roundtrip for each result.
    await this.db.batch(events.map(event => ({
      sql: "INSERT OR IGNORE INTO results VALUES(?,?,?,?,?)",
      args: [userId, game, event.mode === "daily" ? `daily:${event.date}` : `event:${event.eventId}`, JSON.stringify(event), this.now()],
    })));
    return { saved: true };
  }
  async loadProgress(userId: string, game: GameId, key: string) {
    validateKey(key);
    await this.ready;
    return this.loadProgressWith(this.db, userId, game, key);
  }
  private async loadProgressWith(tx: SqlExecutor, userId: string, game: GameId, key: string) {
    const row = (await tx.execute("SELECT value,revision FROM progress WHERE user_id=? AND game=? AND key=?", [userId, game, key])).rows[0];
    return row ? { value: JSON.parse(String(row.value)) as unknown, revision: Number(row.revision) } : null;
  }
  async saveProgress(userId: string, game: GameId, key: string, value: unknown, revision: number, event?: ResultEvent): Promise<ProgressResult> {
    validateKey(key); if (!Number.isInteger(revision) || revision < 0) throw new AccountValidationError("Invalid progress revision");
    const encoded = JSON.stringify(value); if (!encoded || Buffer.byteLength(encoded) > 131072) throw new AccountValidationError("Progress is too large"); if (event) validateEvent(game, event);
    return this.transaction(async tx => {
      const current = await this.loadProgressWith(tx, userId, game, key);
      if ((current?.revision || 0) !== revision) return { saved: false, conflict: true, revision: current?.revision || 0, value: current?.value ?? null };
      if (!current) {
        const count = (await tx.execute("SELECT COUNT(*) AS n FROM progress WHERE user_id=? AND game=?", [userId, game])).rows[0];
        if (Number(count.n) >= 30) await tx.execute("DELETE FROM progress WHERE rowid IN (SELECT rowid FROM progress WHERE user_id=? AND game=? ORDER BY updated_at LIMIT 1)", [userId, game]);
      }
      await tx.execute("INSERT INTO progress VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,game,key) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at", [userId, game, key, encoded, revision + 1, this.now()]);
      const result = event ? await this.resultWith(tx, userId, game, event) : null;
      return { saved: true, revision: revision + 1, ...(result ? { event: result.event, duplicate: result.duplicate } : {}) };
    });
  }
  async stats(user: AccountUser | null): Promise<AccountStats> {
    await this.ready;
    // One query gives the combined view a consistent snapshot across games.
    const history = user ? (await this.db.execute("SELECT game,value,created_at FROM results WHERE user_id=? ORDER BY created_at DESC", [user.id])).rows : [];
    const games = Object.fromEntries((["blackjack", "tempo", "encore", "double-drop"] as const).map((game) => {
      const rows = history.filter(row => row.game === game);
      const events = rows.map((row) => ({ event: JSON.parse(String(row.value)) as ResultEvent, date: new Date(Number(row.created_at)).toISOString() }));
      const completed = events.filter(({ event }) => event.status !== "incomplete");
      const total = completed.reduce((sum, { event }) => sum + event.score, 0);
      const streakEvents = completed.filter(({ event }) => game === "encore" || (event.mode === "daily" && (game !== "blackjack" || event.won)));
      const dates = [...new Set(streakEvents.map(({ event, date }) => event.date || date.slice(0, 10)))].sort();
      let bestStreak = 0; let run = 0; let previous = 0;
      for (const date of dates) { const day = Date.parse(date) / 86400000; run = day === previous + 1 ? run + 1 : 1; previous = day; bestStreak = Math.max(bestStreak, run); }
      // Tempo's shared puzzle changes at midnight India time; the other games
      // keep their existing UTC streak boundary.
      const today = Math.floor((this.now() + (game === "tempo" ? 330 * 60 * 1000 : 0)) / 86400000);
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
          eventId: event.eventId, date: event.date || date.slice(0, 10), mode: event.mode,
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
  if (incomplete && (game !== "encore" && game !== "double-drop" || event.mode === "daily" && game !== "double-drop" || event.won === true)) throw new AccountValidationError("Invalid incomplete result");
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
    if (!["practice", "daily"].includes(event.mode) || !Number.isInteger(event.score) || !Number.isInteger(event.maxScore) || event.correct !== event.score || event.rounds !== event.maxScore || typeof event.won !== "boolean" || !Number.isSafeInteger(event.bankedPoints) || event.bankedPoints! < 0 || event.bankedPoints! > 1000000000 || (!incomplete && !event.won && event.bankedPoints !== 0) || (event.bankedPoints! > 0 && event.correct === 0) || (event.won && !event.bankedPoints)) throw new AccountValidationError("Invalid Double or Drop result");
    if (event.mode === "daily" && (event.maxScore > 10 || incomplete && event.maxScore >= 10)) throw new AccountValidationError("Invalid daily Double or Drop length");
  } else if (event.bankedPoints !== undefined) throw new AccountValidationError("Banked points belong to Double or Drop");
  if (Buffer.byteLength(JSON.stringify(event)) > 4096) throw new AccountValidationError("Result is too large");
}
