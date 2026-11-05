import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordingKey, normalize, titleKey } from "./recordings.ts";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const WORKSPACE = resolve(ROOT, "..");
export interface Track {
  id: string; title: string; artist: string; primary_artist: string; album: string;
  duration_ms: number | null; release_date: string | null; popularity: number;
  language: string | null; language_source: string | null;
  bpm: number | null; bpm_source: string | null; bpm_quality: string;
  genre: string; recording_key: string; source: string; instrumentalness: number | null;
}
export function openStore(path = resolve(ROOT, "data/music.sqlite")) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, primary_artist TEXT NOT NULL,
      artist_key TEXT NOT NULL, title_key TEXT NOT NULL, recording_key TEXT NOT NULL,
      album TEXT NOT NULL DEFAULT '', duration_ms INTEGER, release_date TEXT,
      popularity INTEGER NOT NULL DEFAULT 0, language TEXT, language_source TEXT,
      bpm REAL, bpm_source TEXT, bpm_quality TEXT NOT NULL DEFAULT 'estimated',
      genre TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, instrumentalness REAL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tracks_artist_idx ON tracks(artist_key);
    CREATE INDEX IF NOT EXISTS tracks_recording_idx ON tracks(recording_key);
    CREATE INDEX IF NOT EXISTS tracks_english_idx ON tracks(language, popularity DESC);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, url TEXT NOT NULL, license TEXT NOT NULL, imported_at TEXT, row_count INTEGER, sha256 TEXT);
    CREATE TABLE IF NOT EXISTS media (
      track_id TEXT PRIMARY KEY REFERENCES tracks(id), provider TEXT NOT NULL,
      provider_id TEXT NOT NULL, preview_url TEXT NOT NULL, artwork_url TEXT NOT NULL,
      purchase_url TEXT NOT NULL, album TEXT NOT NULL, release_date TEXT,
      matched_at TEXT NOT NULL, checked_at TEXT, status TEXT NOT NULL DEFAULT 'matched',
      duration_ms INTEGER NOT NULL, match_method TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stream_snapshots (
      track_id TEXT NOT NULL REFERENCES tracks(id), observed_on TEXT NOT NULL,
      streams INTEGER NOT NULL CHECK(streams>0), source TEXT NOT NULL, match_method TEXT NOT NULL,
      PRIMARY KEY(track_id, observed_on)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      kind TEXT NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL, details TEXT, PRIMARY KEY(kind, job_key)
    );
    CREATE TABLE IF NOT EXISTS releases (game TEXT NOT NULL, version TEXT NOT NULL, effective_on TEXT NOT NULL, count INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(game,effective_on));
  `);
  if (!db.prepare("PRAGMA table_info(tracks)").all().some(column => column.name === "language_review_required")) {
    db.exec("ALTER TABLE tracks ADD COLUMN language_review_required INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}
export function trackWriter(db: DatabaseSync) {
  const statement = db.prepare(`INSERT INTO tracks(id,title,artist,primary_artist,artist_key,title_key,recording_key,album,duration_ms,release_date,popularity,language,language_source,bpm,bpm_source,bpm_quality,genre,source,instrumentalness,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    popularity=max(tracks.popularity,excluded.popularity),
    language=CASE WHEN tracks.language_source='manual-reviewed' THEN tracks.language ELSE coalesce(excluded.language,tracks.language) END,
    language_source=CASE WHEN tracks.language_source='manual-reviewed' THEN tracks.language_source ELSE coalesce(excluded.language_source,tracks.language_source) END,
    release_date=coalesce(excluded.release_date,tracks.release_date),
    bpm=CASE WHEN tracks.bpm_quality='reviewed' THEN tracks.bpm ELSE coalesce(excluded.bpm,tracks.bpm) END,
    bpm_source=CASE WHEN tracks.bpm_quality='reviewed' THEN tracks.bpm_source ELSE coalesce(excluded.bpm_source,tracks.bpm_source) END,
    bpm_quality=CASE WHEN tracks.bpm_quality='reviewed' THEN tracks.bpm_quality ELSE excluded.bpm_quality END,
    updated_at=excluded.updated_at`);
  return (t: Omit<Track, "recording_key">) => {
    if (!/^[A-Za-z0-9]{22}$/.test(t.id) || !t.title || !t.primary_artist) return false;
    statement.run(t.id,t.title,t.artist,t.primary_artist,normalize(t.primary_artist),titleKey(t.title),recordingKey(t.title,t.primary_artist),t.album,t.duration_ms,t.release_date,t.popularity,t.language,t.language_source,t.bpm,t.bpm_source,t.bpm_quality,t.genre,t.source,t.instrumentalness,new Date().toISOString());
    return true;
  };
}
export function stats(db: DatabaseSync) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    tracks: count("SELECT count(*) n FROM tracks"),
    distinctRecordings: count("SELECT count(DISTINCT recording_key) n FROM tracks"),
    artists: count("SELECT count(DISTINCT artist_key) n FROM tracks"),
    englishLabelled: count("SELECT count(*) n FROM tracks WHERE language='en'"),
    englishPendingLanguageReview: count("SELECT count(*) n FROM tracks WHERE language='en' AND language_review_required=1"),
    withBpm: count("SELECT count(*) n FROM tracks WHERE bpm BETWEEN 40 AND 220"),
    matchedPreviews: count("SELECT count(*) n FROM media"),
    checkedPreviews: count("SELECT count(*) n FROM media WHERE status='available'"),
    withStreamSnapshots: count("SELECT count(DISTINCT track_id) n FROM stream_snapshots"),
    englishWithStreams: count("SELECT count(DISTINCT t.recording_key) n FROM tracks t JOIN stream_snapshots s ON s.track_id=t.id WHERE t.language='en'"),
    previewJobs: db.prepare("SELECT status,count(*) count FROM jobs WHERE kind='apple-artist' GROUP BY status").all(),
  };
}
