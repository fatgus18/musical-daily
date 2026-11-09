import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validateCatalog, validateTrack, MAX_CATALOG_BYTES, MAX_CATALOG_TRACKS, catalogStatus, isPreviewUrl } from "../src/lib/catalog.ts";
import { publishCatalog } from "../src/lib/catalog-publication.ts";
export { publishCatalog } from "../src/lib/catalog-publication.ts";
import type { Catalog, CatalogSource, CatalogTrack } from "../src/lib/catalog-types.ts";
import { artistPoolTracks, LIVE_SOURCES } from "../src/lib/catalog-artists.ts";
import type { ArtistPool } from "../../shared/music-provider/catalog.ts";
import { searchArtists, loadArtist, normalize as normalizeArtist } from "../../shared/music-provider/catalog.ts";

const ROOT = resolve(import.meta.dirname, "..");
const KWORB = "https://kworb.net/spotify/songs.html";
const FEATURE_SOURCE = "https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset";
const LANGUAGE_SOURCE = "https://github.com/cu-sanjay/MusicRecommender/blob/main/spotify_songs.csv";
const RETENTION_DAYS = 35;
const MAX_TRACKS = MAX_CATALOG_TRACKS;
const SOURCES: CatalogSource[] = [
  { id: "spotify-metadata", url: FEATURE_SOURCE, note: "Historical Spotify metadata/audio-feature dataset; BPM is a provider estimate, not a listening review. Imported timestamps are not measurement dates." },
  { id: "english-labelled-metadata", url: LANGUAGE_SOURCE, note: "Metadata only from the documented Spotify audio-features dataset mirror; explicit English labels, conservatively filtered. No lyrics or audio are stored. The mirror's reuse license is unspecified; production distribution needs source review." },
  { id: "kworb-stream-observations", url: KWORB, note: "Observed Spotify stream totals, matched by exact artist/title and compatible recording duration. A dated snapshot, not a live Spotify counter." },
  { id: "apple-recording-artwork", url: "https://performance-partners.apple.com/search-api", note: "Artwork references from previously matched Apple recording metadata; no image or audio files are downloaded. Provider attribution links remain attached." },
];

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}
function key(title: string, artist: string) { return `${normalize(artist)}::${normalize(title)}`; }
function genre(value: string): string {
  if (/^(pop|synth-pop|indie-pop|power-pop|dance-pop)$/.test(value)) return "pop";
  if (/rock|grunge|punk|metal|^(alternative|emo)$/.test(value)) return "rock";
  if (/^(rap|hip-hop)$/.test(value)) return "hip-hop";
  if (/^(r&b|soul|funk|blues|disco)$/.test(value)) return "rnb";
  if (/edm|house|electro|techno|trance|^(dance|dub|garage|drum-and-bass|breakbeat)$/.test(value)) return "electronic";
  if (/country/.test(value)) return "country";
  if (/jazz/.test(value)) return "jazz";
  if (/folk|acoustic|singer-songwriter/.test(value)) return "folk";
  return "other";
}

interface DatabaseTrack {
  id: string; title: string; artist: string; primary_artist: string; duration_ms: number | null;
  bpm: number | null; bpm_source: string | null; bpm_quality: string; source: string; genre: string; popularity: number;
  streams: number | null; stream_source: string | null; observed_on: string | null;
  artwork_url: string | null; purchase_url: string | null; preview_url: string | null; media_status: string | null; media_duration: number | null;
}

/** A one-time/import-time adapter. The deployed app never opens its sibling's database. */
export function importDatabase(path: string): CatalogTrack[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT t.id,t.title,t.artist,t.primary_artist,t.duration_ms,t.bpm,t.bpm_source,t.bpm_quality,t.source,t.genre,t.popularity,
      m.artwork_url,m.purchase_url,m.preview_url,m.status media_status,m.duration_ms media_duration,s.streams,s.source stream_source,s.observed_on
      FROM tracks t LEFT JOIN media m ON m.track_id=t.id
      LEFT JOIN stream_snapshots s ON s.track_id=t.id AND s.observed_on=(SELECT max(s2.observed_on) FROM stream_snapshots s2 WHERE s2.track_id=t.id)
      WHERE t.language='en' AND t.language_review_required=0
      AND t.duration_ms BETWEEN 30000 AND 1800000
      ORDER BY (s.streams IS NOT NULL) DESC,(m.artwork_url IS NOT NULL) DESC,t.popularity DESC,t.id`).all() as unknown as DatabaseTrack[];
    const output: CatalogTrack[] = [];
    for (const row of rows) {
      const metadataSource = row.source === "spotify-features-114k" ? FEATURE_SOURCE : LANGUAGE_SOURCE;
      const track: CatalogTrack = { id: row.id, title: row.title, artist: row.artist, primaryArtist: row.primary_artist,
        artwork: row.artwork_url || "", sourceUrl: `https://open.spotify.com/track/${row.id}`, genre: genre(row.genre), popularity: row.popularity,
        metrics: { duration: { value: row.duration_ms! / 1000, sourceUrl: metadataSource, quality: "recording-metadata-snapshot" } } };
      if (row.bpm && row.bpm >= 40 && row.bpm <= 240) {
        track.metrics.tempo = { value: Math.round(row.bpm * 100) / 100, sourceUrl: row.bpm_source?.startsWith("https://") ? row.bpm_source : row.bpm_source === "spotify-features-114k" ? FEATURE_SOURCE : LANGUAGE_SOURCE, quality: row.bpm_quality === "reviewed" ? "reviewed" : "provider-estimate" };
      }
      if (row.streams && row.stream_source && row.observed_on) track.metrics.streams = { value: row.streams, sourceUrl: row.stream_source, asOf: row.observed_on, quality: "observed-count" };
      // Album edition dates are deliberately not presented as original song release years.
      if (row.media_status === "available" && isPreviewUrl(row.preview_url)) { track.previewUrl = row.preview_url; track.previewSourceUrl = row.purchase_url || track.sourceUrl; }
      validateTrack(track); output.push(track);
    }
    if (output.length > MAX_TRACKS) throw new Error("Shared library exceeds the deployment metadata budget; no partial subset was published.");
    if (output.length < 2) throw new Error("Import needs at least two eligible recordings.");
    return output.sort((a, b) => a.id.localeCompare(b.id));
  } finally { db.close(); }
}

interface PublishedTrack { id: string; title: string; artist: string; bpm?: number; bpmSource?: string; bpmQuality?: string; streams?: number; streamsObservedOn?: string; streamsSource?: string; previewUrl?: string; appleMusicUrl?: string; artworkUrl?: string; albumArtUrl?: string }
/** Import every published game release; no favorite-artist or popularity cap is applied. */
export async function importPublishedGames(workspace: string, baseline: CatalogTrack[]) {
  const tracks = new Map(baseline.map(track => [track.id, track]));
  const rejected: string[] = [];
  for (const game of ["tempo-trap", "blackjack-music"]) {
    const directory = resolve(workspace, game, "data");
    const index = JSON.parse(await readFile(resolve(directory, "catalog-releases.json"), "utf8")) as { releases: { version: string }[] };
    for (const release of index.releases) {
      if (!/^[a-f0-9]{12,16}$/.test(release.version)) throw new Error("Invalid source game catalog version.");
      const data = JSON.parse(await readFile(resolve(directory, "catalog-releases", `${release.version}.json`), "utf8")) as { tracks: PublishedTrack[] };
      for (const row of data.tracks) {
        const existing = tracks.get(row.id);
        const track: CatalogTrack = existing ? structuredClone(existing) : { id: row.id, title: row.title, artist: row.artist, artwork: row.artworkUrl || row.albumArtUrl || "", sourceUrl: `https://open.spotify.com/track/${row.id}`, metrics: {} };
        if (!track.metrics.tempo && row.bpm && row.bpmSource) track.metrics.tempo = { value: row.bpm, sourceUrl: row.bpmSource.startsWith("https://") ? row.bpmSource : row.bpmSource === "spotify-features-114k" ? FEATURE_SOURCE : LANGUAGE_SOURCE, quality: row.bpmQuality || "provider-estimate" };
        if (row.streams && row.streamsObservedOn && row.streamsSource && (!track.metrics.streams || row.streamsObservedOn >= track.metrics.streams.asOf!)) track.metrics.streams = { value: row.streams, sourceUrl: row.streamsSource, asOf: row.streamsObservedOn, quality: "observed-count" };
        if (row.previewUrl && isPreviewUrl(row.previewUrl)) { track.previewUrl = row.previewUrl; track.previewSourceUrl = row.appleMusicUrl || track.previewSourceUrl || track.sourceUrl; }
        track.artwork ||= row.artworkUrl || row.albumArtUrl || "";
        if (!Object.keys(track.metrics).length) { rejected.push(`${game}:${row.id}`); continue; } // Legacy undated counts cannot become measured facts.
        validateTrack(track); tracks.set(track.id, track);
      }
    }
  }
  return { tracks: [...tracks.values()], unsupportedLegacyIds: [...new Set(rejected)].filter(id => !tracks.has(id.split(":")[1])) };
}

/** Reuse all loaded Encore discovery songs, including those with unknown popularity. */
export function importEncoreCache(path: string, baseline: CatalogTrack[], now = Date.now()): CatalogTrack[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT value FROM provider_cache WHERE key LIKE 'live-v1:pool:apple:%' AND stale_until > ? AND bytes <= 4194304").all(now) as { value: string }[];
    const tracks = new Map(baseline.map(track => [track.id, track]));
    for (const row of rows) for (const track of artistPoolTracks(JSON.parse(row.value) as ArtistPool, baseline)) tracks.set(track.id, track);
    return [...tracks.values()];
  } finally { db.close(); }
}

/** Cache expiry must not erase a provider recording already published to players. */
export function mergeSharedRefresh(imported: CatalogTrack[], previous: CatalogTrack[]): CatalogTrack[] {
  const latest = new Map(previous.map(track => [track.id, track]));
  const tracks = imported.map(track => {
    const prior = latest.get(track.id)?.metrics.streams;
    return prior && (!track.metrics.streams || prior.asOf! > track.metrics.streams.asOf!)
      ? { ...track, metrics: { ...track.metrics, streams: prior } } : track;
  });
  const importedIds = new Set(tracks.map(track => track.id));
  tracks.push(...previous.filter(track => track.id.startsWith("apple:") && !importedIds.has(track.id)));
  return tracks;
}

function unescapeHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").trim();
}
export function parseStreamPage(html: string): { title: string; artist: string; streams: number }[] {
  const table = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match => match[0]).find(markup => /<th\b[^>]*>\s*Streams\s*<\/th>/i.test(markup));
  if (!table) throw new Error("Stream provider format changed: no Streams column.");
  const results: { title: string; artist: string; streams: number }[] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => unescapeHtml(match[1]));
    const name = cells[0] || ""; const separator = name.indexOf(" - ");
    const streams = Number((cells[1] || "").replaceAll(",", ""));
    if (separator <= 0 || !Number.isSafeInteger(streams) || streams <= 0) continue;
    results.push({ artist: name.slice(0, separator), title: name.slice(separator + 3), streams });
  }
  return results;
}

export function applyStreamRows(tracks: CatalogTrack[], rows: ReturnType<typeof parseStreamPage>, date: string): { tracks: CatalogTrack[]; updated: number } {
  const counts = new Map<string, number | null>();
  for (const row of rows) { const id = key(row.title, row.artist); counts.set(id, counts.has(id) && counts.get(id) !== row.streams ? null : row.streams); }
  let updated = 0;
  const result = tracks.map(track => {
    const streams = counts.get(key(track.title, track.primaryArtist || track.artist));
    if (streams == null) return track;
    // Only upgrade already-evidenced stream identities. New artist/title matches need recording review.
    if (!track.metrics.streams) return track;
    updated++;
    return { ...track, metrics: { ...track.metrics, streams: { value: streams, sourceUrl: KWORB, asOf: date, quality: "observed-count" } } };
  });
  return { tracks: result, updated };
}

async function boundedText(url: URL): Promise<string> {
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Provider URLs must be HTTPS without embedded credentials.");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { "User-Agent": "MusicalDailyCatalog/1.0 (metadata maintenance)", Accept: "application/json,text/html" } });
  if (!response.ok || !response.body) throw new Error(`Provider returned HTTP ${response.status}; the current catalog is unchanged.`);
  if (Number(response.headers.get("content-length") || 0) > MAX_CATALOG_BYTES) throw new Error("Provider response is too large.");
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_CATALOG_BYTES) throw new Error("Provider response is too large."); parts.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString("utf8");
}

export function mergeFeed(existing: CatalogTrack[], payload: unknown): { tracks: CatalogTrack[]; sources: CatalogSource[] } {
  if (!payload || typeof payload !== "object") throw new Error("Provider feed must be an object.");
  const feed = payload as { tracks?: (CatalogTrack & { language?: string })[]; sources?: CatalogSource[] };
  if (!Array.isArray(feed.tracks) || !feed.tracks.length || feed.tracks.length > MAX_TRACKS || !Array.isArray(feed.sources) || !feed.sources.length) throw new Error("Feed needs tracks and source attribution.");
  const tracks = new Map(existing.map(track => [track.id, track])); const ids = new Set<string>(); const recordingKeys = new Set<string>();
  const existingRecordings = new Map(existing.map(track => [key(track.title, track.primaryArtist || track.artist), track.id]));
  for (const item of feed.tracks) {
    if (item.language !== "en") throw new Error("Feed records need explicit English language evidence; unknown language is not inferred.");
    if (!item.languageSource?.startsWith("https://")) throw new Error("Feed records need a languageSource evidence URL.");
    if (ids.has(item.id)) throw new Error("Duplicate recording IDs in feed."); ids.add(item.id);
    const recording = key(item.title, item.primaryArtist || item.artist);
    if (recordingKeys.has(recording)) throw new Error("Duplicate recording identities in feed."); recordingKeys.add(recording);
    const { language: _language, ...track } = item;
    void _language;
    validateTrack(track);
    const previousRecordingId = existingRecordings.get(recording);
    if (previousRecordingId && previousRecordingId !== track.id) tracks.delete(previousRecordingId);
    const previousId = tracks.get(track.id);
    if (previousId) existingRecordings.delete(key(previousId.title, previousId.primaryArtist || previousId.artist));
    existingRecordings.set(recording, track.id);
    tracks.set(track.id, track);
  }
  if (tracks.size > MAX_TRACKS) throw new Error(`Catalog exceeds ${MAX_TRACKS} metadata records. Increase the deployment memory budget before publishing.`);
  return { tracks: [...tracks.values()].sort((a, b) => a.id.localeCompare(b.id)), sources: feed.sources };
}

/** Retain every saved run's version, the newest five, and a 35-day rollback window. */
export async function pruneCatalogs(referencedVersions: string[], output = resolve(ROOT, "data"), now = Date.now()) {
  if (!Array.isArray(referencedVersions) || referencedVersions.some(version => !/^[a-f0-9]{16}$/.test(version))) throw new Error("Pruning requires validated saved-run version references.");
  const dir = resolve(output, "catalog-releases");
  const { current } = JSON.parse(await readFile(resolve(output, "catalog-releases.json"), "utf8")) as { current: string };
  const files = await Promise.all((await readdir(dir)).filter(name => /^[a-f0-9]{16}\.json$/.test(name)).map(async name => ({ name, modified: (await stat(resolve(dir, name))).mtimeMs })));
  files.sort((a, b) => b.modified - a.modified);
  const retained = new Set([...files.slice(0, 5).map(file => file.name), ...referencedVersions.map(version => `${version}.json`)]); retained.add(`${current}.json`);
  let removed = 0;
  for (const file of files) if (!retained.has(file.name) && file.modified < now - RETENTION_DAYS * 86400000) { await unlink(resolve(dir, file.name)); removed++; }
  return removed;
}

export async function main(args = process.argv.slice(2)) {
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`); return args[index + 1]; };
  const output = resolve(option("--output") || resolve(ROOT, "data"));
  let tracks: CatalogTrack[]; let sources: CatalogSource[];
  if (args.includes("--limit")) throw new Error("Song-count limits have been removed. Import the complete suitable source collection.");
  const workspace = resolve(ROOT, "..");
  const database = option("--from-database") || (args.includes("--shared") ? resolve(workspace, "music-catalog/data/music.sqlite") : undefined);
  if (database && !existsSync(database) && args.includes("--optional")) {
    console.log("Shared maintenance database is not present; using the deployed immutable catalog. Live artist discovery remains available."); return;
  }
  if (database) { tracks = importDatabase(resolve(database)); sources = SOURCES; }
  else { const pointer = JSON.parse(await readFile(resolve(output, "catalog-releases.json"), "utf8")) as { current: string }; if (!/^[a-f0-9]{16}$/.test(pointer.current)) throw new Error("Invalid release pointer."); const current = JSON.parse(await readFile(resolve(output, "catalog-releases", `${pointer.current}.json`), "utf8")) as Catalog; validateCatalog(current); tracks = current.tracks; sources = current.sources; }
  if (args.includes("--shared")) {
    const imported = await importPublishedGames(workspace, tracks); tracks = imported.tracks;
    if (imported.unsupportedLegacyIds.length) console.log(`${imported.unsupportedLegacyIds.length} old seed IDs have only undated, unsourced counts and cannot form fair questions.`);
    const encoreCache = option("--encore-cache") || process.env.MUSIC_PROVIDER_CACHE_PATH || process.env.ENCORE_CATALOG_CACHE_PATH || resolve(workspace, "artist-encore/data/runtime/catalog.sqlite");
    if (existsSync(encoreCache)) { tracks = importEncoreCache(encoreCache, tracks); sources = [...sources, ...LIVE_SOURCES]; }
    // Source refreshes must never replace a newer evidenced count with an older snapshot.
    try {
      const pointer = JSON.parse(await readFile(resolve(output, "catalog-releases.json"), "utf8")) as { current: string };
      if (!/^[a-f0-9]{16}$/.test(pointer.current)) throw new Error("Invalid existing catalog pointer.");
      const previous = JSON.parse(await readFile(resolve(output, "catalog-releases", `${pointer.current}.json`), "utf8")) as Catalog; validateCatalog(previous);
      tracks = mergeSharedRefresh(tracks, previous.tracks);
      sources = [...new Map([...previous.sources, ...sources].map(source => [source.id, source])).values()];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const feedUrl = option("--feed");
  if (feedUrl) { const merged = mergeFeed(tracks, JSON.parse(await boundedText(new URL(feedUrl)))); tracks = merged.tracks; sources = [...sources, ...merged.sources]; }
  if (args.includes("--streams")) {
    const rows = parseStreamPage(await boundedText(new URL(KWORB)));
    if (rows.length < 100) throw new Error("Stream response is incomplete; no release published.");
    const update = applyStreamRows(tracks, rows, new Date().toISOString().slice(0, 10));
    if (update.updated < 20) throw new Error("Too few verified stream identities matched; no release published.");
    tracks = update.tracks; console.log(`Updated ${update.updated} evidenced stream counts.`);
  }
  const artistNames = args.flatMap((argument, index) => argument === "--artist" ? [args[index + 1]] : []);
  if (artistNames.some(name => !name || name.startsWith("--"))) throw new Error("Each --artist requires an artist name.");
  for (const name of artistNames) {
    const matches = (await searchArtists(name)).filter(artist => normalizeArtist(artist.name) === normalizeArtist(name));
    if (matches.length !== 1) throw new Error(`Artist name '${name}' is missing or ambiguous in the provider catalog; no release published.`);
    const pool = await loadArtist(matches[0].id, { continue: args.includes("--continue") });
    const discovered = artistPoolTracks(pool, tracks);
    tracks = [...new Map([...tracks, ...discovered].map(track => [track.id, track])).values()];
    sources = [...new Map([...sources, ...LIVE_SOURCES].map(source => [source.id, source])).values()];
    console.log(`${pool.artist.name}: ${discovered.length} provider recordings imported (${pool.coverage?.status || "loaded"}).`);
  }
  tracks.sort((a, b) => a.id.localeCompare(b.id));
  const published = await publishCatalog(tracks, sources, output);
  console.log(JSON.stringify(catalogStatus(published), null, 2));
  if (args.includes("--prune")) {
    const gameDb = new DatabaseSync(resolve(option("--game-db") || process.env.DOUBLE_DROP_DB_PATH || resolve(ROOT, "data/double-drop.sqlite")), { readOnly: true });
    try {
      const versions = gameDb.prepare("SELECT DISTINCT json_extract(state, '$.catalogVersion') version FROM games").all().map(row => String(row.version));
      console.log(`Removed ${await pruneCatalogs(versions, output)} unreferenced metadata releases.`);
    } finally { gameDb.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : "Catalog refresh failed."); process.exitCode = 1; });
