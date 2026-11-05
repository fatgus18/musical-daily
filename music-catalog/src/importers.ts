import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { load } from "cheerio";
import { cachedText, checksum, request } from "./network.ts";
import { normalize, recordingKey } from "./recordings.ts";
import { trackWriter, WORKSPACE, type Track } from "./store.ts";

export const SOURCES = {
  spotify: { id: "spotify-features-114k", url: "https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset/resolve/635b034f69257814eff850a5c2b3346fe458134f/dataset.csv", license: "bsd (dataset card); underlying provider terms apply" },
  language: { id: "nakhaee-language-features", url: "https://raw.githubusercontent.com/cu-sanjay/MusicRecommender/main/spotify_songs.csv", license: "unspecified; mirror of Muhammad Nakhaee's Kaggle Audio Features and Lyrics of Spotify Songs; metadata fields only" },
  kworb: { id: "kworb-alltime", url: "https://kworb.net/spotify/songs.html", license: "provider terms; attributed stream-count observations" },
};
export function flagLanguageUncertainty(db:DatabaseSync){
  // Language-labelled lyric sources can contain English translations. These catalog contexts
  // require recording-level review; this does not assert every song by the artist is non-English.
  const contexts="'k-pop','j-pop','j-idol','j-rock','cantopop','mandopop','latin','latino','reggaeton','reggaeton-flow','french','german','spanish','brazil','brazilian','pagode','sertanejo','forro','samba','mpb','malay','indian','tamil','turkish','iranian'";
  db.exec(`UPDATE tracks SET language_review_required=0;
    UPDATE tracks SET language_review_required=1 WHERE language='en' AND language_source!='manual-reviewed'
    AND (genre IN(${contexts}) OR artist_key IN(SELECT artist_key FROM tracks GROUP BY artist_key HAVING sum(CASE WHEN genre IN(${contexts}) THEN 1 ELSE 0 END)*1.0/count(*)>=0.5));
    UPDATE tracks SET language_review_required=0 WHERE language_source='manual-reviewed';`);
}
function numeric(value: unknown): number | null { const n = Number(value); return value !== "" && value != null && Number.isFinite(n) ? n : null; }
function registerSource(db: DatabaseSync, source: {id:string;url:string;license:string}, rows: number, hash: string) {
  db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET imported_at=excluded.imported_at,row_count=excluded.row_count,sha256=excluded.sha256,url=excluded.url").run(source.id,source.url,source.license,new Date().toISOString(),rows,hash);
}
export async function importDatasets(db: DatabaseSync, refresh = false) {
  for (const kind of ["spotify", "language"] as const) {
    const source = SOURCES[kind];
    if (!refresh && db.prepare("SELECT id FROM sources WHERE id=? AND imported_at IS NOT NULL").get(source.id)) { console.log(`${source.id}: already imported; use --refresh to re-fetch`); continue; }
    console.log(`Importing ${source.id}…`);
    // The language file also contains lyrics. Parse in memory and discard them; never persist that column or source file.
    const text = kind === "spotify" ? await cachedText(source.url, "spotify-features.csv", refresh) : await (await request(source.url, { signal: AbortSignal.timeout(300000) })).text();
    const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: false }) as Record<string,string>[];
    const put = trackWriter(db); let imported = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const title = row.track_name?.trim();
        const artists = (row.artists || row.track_artist || "").split(";").map(a => a.trim()).filter(Boolean);
        const bpm = numeric(row.tempo);
        if (!title || !artists.length) continue;
        const language = row.language && row.language !== "NA" ? row.language : null;
        if (put({ id: row.track_id, title, artist: artists.join(", "), primary_artist: artists[0], album: row.album_name || row.track_album_name || "",
          duration_ms: numeric(row.duration_ms), release_date: row.track_album_release_date || null,
          popularity: numeric(row.popularity || row.track_popularity) || 0, language, language_source: language ? source.id : null,
          bpm: bpm && bpm >= 40 && bpm <= 220 ? bpm : null, bpm_source: source.id, bpm_quality: "provider-estimate", genre: row.track_genre || row.playlist_genre || "", source: source.id,
          instrumentalness: numeric(row.instrumentalness) })) imported++;
      }
      registerSource(db, source, imported, checksum(text)); db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    console.log(`${source.id}: imported ${imported.toLocaleString()} rows; deduplicated by Spotify ID`);
  }
  await importReviewed(db);
  // Transfer an explicit source language label only across matching title/artist AND near-identical duration.
  db.exec(`UPDATE tracks AS t SET language=(SELECT e.language FROM tracks e WHERE e.recording_key=t.recording_key AND e.language IS NOT NULL AND abs(e.duration_ms-t.duration_ms)<=2500 ORDER BY e.language_source='manual-reviewed' DESC LIMIT 1),
    language_source='recording-match-to-source-label'
    WHERE t.language IS NULL AND EXISTS(SELECT 1 FROM tracks e WHERE e.recording_key=t.recording_key AND e.language IS NOT NULL AND abs(e.duration_ms-t.duration_ms)<=2500)`);
  flagLanguageUncertainty(db);
}
export async function importReviewed(db: DatabaseSync) {
  const catalog = JSON.parse(await readFile(resolve(WORKSPACE,"tempo-trap/data/catalog.json"),"utf8"));
  const seeds = JSON.parse(await readFile(resolve(WORKSPACE,"tempo-trap/data/seeds.json"),"utf8")) as {id:string;bpm:number;source:string}[];
  const put = trackWriter(db);
  for (const t of catalog.tracks) {
    const seed = seeds.find(s => s.id === t.id); if (!seed) continue;
    put({id:t.id,title:t.title,artist:t.artist,primary_artist:t.artist,album:t.album,duration_ms:null,release_date:String(t.year),popularity:80,language:"en",language_source:"manual-reviewed",bpm:seed.bpm,bpm_source:seed.source,bpm_quality:"reviewed",genre:"",source:"reviewed-seed",instrumentalness:null});
    db.prepare("UPDATE tracks SET bpm=?,bpm_source=?,bpm_quality='reviewed',language='en',language_source='manual-reviewed' WHERE id=?").run(seed.bpm,seed.source,t.id);
    db.prepare(`INSERT INTO media(track_id,provider,provider_id,preview_url,artwork_url,purchase_url,album,release_date,matched_at,checked_at,status,duration_ms,match_method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(track_id) DO NOTHING`).run(t.id,"apple",String(t.appleTrackId),t.previewUrl,t.artworkUrl,t.appleMusicUrl,t.album,String(t.year),catalog.checkedAt,catalog.checkedAt,"available",0,"reviewed-seed");
  }
}
export interface StreamRow { artist: string; title: string; streams: number }
export function parseStreams(html: string): StreamRow[] {
  const $ = load(html); const results: StreamRow[] = [];
  $("table").each((_, table) => {
    const headings = $(table).find("thead th").map((_, cell) => $(cell).text().trim()).get();
    if (!headings.includes("Streams")) return;
    $(table).find("tbody tr").each((_, row) => {
      const cells = $(row).find("td"); const name = cells.eq(0).text().trim();
      const separator = name.indexOf(" - ");
      const streams = Number(cells.eq(1).text().replaceAll(",", "").trim());
      if (separator <= 0 || !Number.isSafeInteger(streams) || streams <= 0) return;
      results.push({ artist:name.slice(0,separator),title:name.slice(separator+3),streams });
    });
  });
  return results;
}
export async function importStreams(db: DatabaseSync) {
  const source=SOURCES.kworb;
  const html=await cachedText(source.url,`kworb-${new Date().toISOString().slice(0,10)}.html`);
  const rows=parseStreams(html);
  if(rows.length<100) throw new Error("Stream source format changed or incomplete response; existing snapshots retained.");
  const find=db.prepare("SELECT * FROM tracks WHERE recording_key=? ORDER BY popularity DESC");
  const insert=db.prepare("INSERT INTO stream_snapshots VALUES(?,?,?,?,?) ON CONFLICT(track_id,observed_on) DO NOTHING");
  const observed=new Date().toISOString().slice(0,10); let matched=0;
  db.exec("BEGIN IMMEDIATE");
  try{
    for(const row of rows){
      const candidates=find.all(recordingKey(row.title,row.artist)) as unknown as Track[];
      if(!candidates.length)continue;
      // This source gives artist/title rather than IDs. Reject records with conflicting durations.
      const durations=candidates.map(t=>t.duration_ms).filter((n):n is number=>n!==null);
      if(durations.length && Math.max(...durations)-Math.min(...durations)>5000)continue;
      const track=candidates[0];
      if(normalize(track.primary_artist)!==normalize(row.artist))continue;
      insert.run(track.id,observed,row.streams,source.url,"exact-artist-title; compatible recording durations"); matched++;
    }
    registerSource(db,source,rows.length,checksum(html)); db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  console.log(`Stream snapshots: ${matched.toLocaleString()} exact recording matches from ${rows.length.toLocaleString()} source rows (${observed})`);
}
