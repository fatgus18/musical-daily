import { createHash } from "node:crypto";
import { metadataCache, waitForCached } from "./provider-cache.ts";
import { loadArtistStreams, type ArtistStreams } from "./stream-provider.ts";
import { tierPools } from "./ranking.ts";
import { boundedResponseText } from "./provider-http.ts";
import { loadArtistPortrait } from "./artist-image.ts";

export interface Artist { id: string; name: string; image: string; url: string; genre?: string; imageSourceUrl?: string; imageAttribution?: string }
export interface Track {
  id: string; title: string; aliases: string[]; artistId: string; artist: string;
  preview: string; artwork: string; url: string; duration: number; rank: number;
  /** A stable song identity across album/single/reissue IDs, for repeat prevention. */
  recordingKey?: string;
  spotifyId?: string;
  rankSourceUrl?: string;
  /** Cross-provider count evidence; this is not an ISRC match. */
  rankMatch?: "artist-title" | "artist-title-duration";
  version?: "live";
}
export interface CatalogCoverage {
  previewable: number; ranked: number; releaseCount: number; loadedReleases: number;
  status: "complete" | "partial" | "provider-limited"; hasMore: boolean; stale?: boolean; message?: string;
}
export interface ArtistPool {
  artist: Artist; tracks: Track[];
  ranking: { kind: "streams" | "provider-rank" | "catalog-popularity" | "unranked"; label: string; sourceUrl: string; asOf: string };
  discoveryTracks?: Track[];
  coverage?: CatalogCoverage;
  fetchedAt: number;
}
export class CatalogError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 503, code = "catalog_unavailable") {
    super(message); this.name = "CatalogError"; this.status = status; this.code = code;
  }
}

type JsonObject = Record<string, unknown>;
type PopularityRow = [string, string, string, number, number, number, string | null];
type StreamRow = [string, string, number, number, string, string];
type FullStreamRow = [string, string, number, string, string, string];
export interface RankingIndex {
  version: number; exportedAt: string; sources: { id: string; url: string }[];
  tracks: PopularityRow[]; streams: StreamRow[]; fullStreams?: FullStreamRow[];
}
interface CatalogIndex {
  data: RankingIndex;
  byRecording: Map<string, PopularityRow[]>;
  streamsByRecording: Map<string, StreamRow[]>;
  byArtist: Map<string, PopularityRow[]>;
  fullStreamsByRecording: Map<string, FullStreamRow[]>;
}

const CACHE_VERSION = "live-v1";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const SEARCH_TTL = 24 * 60 * 60 * 1000;
const MAX_POOL_TRACKS = 5000;
const MIN_POOL_TRACKS = 20;
const API_TIMEOUT = 12_000;
const APPLE_PACING = 3200; // Apple's published approximate ceiling is 20 calls/minute.
const MAX_WAITING_CALLS = 12;
const inFlight = new Map<string, Promise<unknown>>();
let waitingAppleRequests = 0;

export function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
export function baseTitle(title: string): string {
  return title.replace(/\s*[([](?:feat\.?|featuring|with)\s+[^)\]]+[)\]]/gi, "")
    .replace(/\s*(?:[-–—]\s*)?(?:\(\s*)?(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s*\))?\s*$/i, "").trim();
}
export function songKey(title: string, artist: string): string { return `${normalize(artist)}::${normalize(baseTitle(title).replace(/\bpt\.?\s+(?=\d)/gi, "part "))}`; }
export function isAlternate(title: string, album = ""): boolean {
  // Word boundaries alone would incorrectly reject songs named Live Forever or Cover Me.
  return /(?:\(|\[|[-–—]\s|^)(?:[^)\]]{0,30}\s)?(?:remix|karaoke|instrumental|acoustic|live(?:\s+(?:at|from|in|version)|(?=[)\]]|$))|sped[ -]up|slowed|nightcore|demo|re[- ]recorded|radio edit|taylor.s version)\b/i.test(title)
    || /\b(?:karaoke|tribute to|in the style of|live at|live from|live in|live album)\b/i.test(album)
    || /\b(?:remix|sped[ -]up|slowed|nightcore|karaoke)\b/i.test(title);
}
const LIVE_SUFFIX = /\s*(?:[-–—]\s*|\(|\[)(?:live(?:\s+(?:at|from|in|version|on)\b[^)\]]*)?|[^)\]]*\b(?:live lounge|sessions?(?: show)?))\s*[)\]]?\s*$/i;
function liveBase(title: string): string { return baseTitle(title).replace(LIVE_SUFFIX, "").trim(); }
function rejectVersion(title: string, album = ""): boolean {
  // A song released only as a live recording (e.g. an album's original version)
  // remains eligible. A studio sibling takes precedence during deduplication.
  return /\bchoral version\b/i.test(title) || isAlternate(title.replace(LIVE_SUFFIX, ""), album.replace(/\blive(?:\s+(?:at|from|in)\b[^)]*)?\b/gi, ""));
}
export function distinctRecordings(tracks: Track[]): Track[] {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = songKey(liveBase(track.title), track.artist);
    groups.set(key, [...(groups.get(key) || []), track]);
  }
  return [...groups].map(([key, versions]) => {
    const studio = versions.filter(track => !track.version);
    const candidates = studio.length ? studio : versions;
    // Only one live version if no studio recording is available; no title is counted twice.
    const track = [...candidates].sort((a, b) => a.title.length - b.title.length || a.id.localeCompare(b.id))[0];
    return { ...track, recordingKey: key, aliases: [...new Set(candidates.flatMap(item => [item.title, liveBase(item.title), ...item.aliases]))] };
  });
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function positiveId(value: unknown): string { const id = String(value ?? ""); return /^\d{1,15}$/.test(id) && Number(id) > 0 ? id : ""; }
function safeUrl(value: unknown, domains: string[]): string {
  if (string(value).length > 4096) return "";
  try { const url = new URL(string(value)); return url.protocol === "https:" && !url.username && !url.password && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : ""; }
  catch { return ""; }
}
export function isPreviewUrl(value: string): boolean { return Boolean(safeUrl(value, ["itunes.apple.com", "mzstatic.com", "dzcdn.net"])); }

async function cacheGet<T>(key: string): Promise<T | undefined> { return (await metadataCache().get<T>(key))?.value; }
async function cachePut(key: string, value: unknown, ttl: number): Promise<void> { await metadataCache().put(key, value, ttl); }
async function singleFlight<T>(key: string, callback: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key); if (existing) return existing as Promise<T>;
  const pending = callback(); inFlight.set(key, pending);
  try { return await pending; } finally { inFlight.delete(key); }
}
async function requestJson(url: URL): Promise<JsonObject> {
  const apple = url.hostname === "itunes.apple.com";
  if (!(apple || url.hostname === "api.deezer.com") || url.protocol !== "https:") throw new CatalogError("Invalid music provider.");
  if (apple) {
    if (waitingAppleRequests >= MAX_WAITING_CALLS) throw new CatalogError("Music search is busy. Please try again in a moment.", 429, "provider_busy");
    const delay = await metadataCache().reserve("apple", APPLE_PACING, 20_000);
    if (delay === undefined) throw new CatalogError("Music search is busy. Please try again in a moment.", 429, "provider_busy");
    waitingAppleRequests++;
    try { if (delay) await new Promise(resolveWait => setTimeout(resolveWait, delay)); }
    finally { waitingAppleRequests--; }
  }
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(API_TIMEOUT), redirect: "error", cache: "no-store" });
    if (!response.ok) throw new CatalogError(response.status === 429 ? "Music search is busy. Please try again shortly." : "The music provider is unavailable. Please try again.", response.status === 429 ? 429 : 503);
    const body = await boundedResponseText(response, 5_000_000);
    const result = object(JSON.parse(body));
    if (result.error) throw new CatalogError("The music provider could not load this artist.");
    return result;
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("Music search timed out or is unavailable. Please try again.");
  }
}
async function appleRequest(path: "search" | "lookup", params: Record<string, string>): Promise<{ entries: JsonObject[]; stale: boolean }> {
  const url = new URL(`https://itunes.apple.com/${path}`);
  for (const [key, value] of Object.entries({ country: "US", ...params })) url.searchParams.set(key, value);
  const key = `${CACHE_VERSION}:provider:${createHash("sha256").update(url.href).digest("hex")}`;
  return singleFlight(key, async () => {
    const cache = metadataCache();
    const cached = await cache.get<JsonObject[]>(key); if (cached) return { entries: cached.value, stale: false };
    const lease = await cache.acquire(key, 45_000);
    if (!lease) {
      const previous = await cache.get<JsonObject[]>(key, true) || await waitForCached<JsonObject[]>(cache, key);
      if (previous) return { entries: previous.value, stale: previous.stale };
      throw new CatalogError("This collection is loading. Please try again in a moment.", 429, "provider_busy");
    }
    try {
      const completed = await cache.get<JsonObject[]>(key); if (completed) return { entries: completed.value, stale: false };
      const result = await requestJson(url);
      if (!Array.isArray(result.results)) throw new CatalogError("Music provider returned an invalid response.");
      const entries = result.results.map(object);
      await cachePut(key, entries, CACHE_TTL); return { entries, stale: false };
    } catch (error) {
      const previous = await cache.get<JsonObject[]>(key, true);
      if (previous) return { entries: previous.value, stale: true };
      throw error;
    } finally { await cache.release(key, lease); }
  });
}

function makeIndex(data: RankingIndex): CatalogIndex {
  const byRecording = new Map<string, PopularityRow[]>(); const byArtist = new Map<string, PopularityRow[]>(); const streamsByRecording = new Map<string, StreamRow[]>();
  const fullStreamsByRecording = new Map<string, FullStreamRow[]>();
  for (const row of data.tracks) {
    if (!(row[4] > 0) || isAlternate(row[1])) continue;
    const key = songKey(row[1], row[2]); const artistKey = normalize(row[2]);
    byRecording.set(key, [...(byRecording.get(key) || []), row]);
    byArtist.set(artistKey, [...(byArtist.get(artistKey) || []), row]);
  }
  for (const row of data.streams) {
    if (!(row[3] > 0) || isAlternate(row[0])) continue;
    const key = songKey(row[0], row[1]); streamsByRecording.set(key, [...(streamsByRecording.get(key) || []), row]);
  }
  for (const row of data.fullStreams || []) {
    if (!Number.isSafeInteger(row[2]) || row[2] <= 0 || rejectVersion(row[0]) || !safeUrl(row[4], ["kworb.net"])) continue;
    const key = songKey(row[0], row[1]); fullStreamsByRecording.set(key, [...(fullStreamsByRecording.get(key) || []), row]);
  }
  return { data, byRecording, byArtist, streamsByRecording, fullStreamsByRecording };
}

function appleArtist(raw: JsonObject): Artist | undefined {
  const id = positiveId(raw.artistId); const name = string(raw.artistName).trim();
  const url = safeUrl(raw.artistLinkUrl || raw.artistViewUrl, ["music.apple.com", "itunes.apple.com"]);
  if (!id || !name || name.length > 180 || !url) return undefined;
  const genre = string(raw.primaryGenreName).trim();
  return { id: `apple:${id}`, name, image: "", url, ...(genre ? { genre } : {}) };
}
export async function searchArtists(query: string): Promise<Artist[]> {
  const cleaned = query.trim().replace(/\s+/g, " ");
  if (cleaned.length < 2 || cleaned.length > 80) throw new CatalogError("Enter an artist name between 2 and 80 characters.", 400, "invalid_query");
  const key = `${CACHE_VERSION}:artists:genre-v2:${normalize(cleaned)}`;
  return singleFlight(key, async () => {
    const cached = await cacheGet<Artist[]>(key); if (cached) return cached;
    const { entries: results } = await appleRequest("search", { term: cleaned, media: "music", entity: "musicArtist", attribute: "artistTerm", limit: "12" });
    const artists = results.filter(result => result.wrapperType === "artist").map(appleArtist).filter((artist): artist is Artist => Boolean(artist));
    const deduped = [...new Map(artists.map(artist => [artist.id, artist])).values()];
    await cachePut(key, deduped, SEARCH_TTL); return deduped;
  });
}

export function appleTrack(raw: JsonObject, artist: Artist): Track | undefined {
  const numericArtist = artist.id.replace(/^apple:/, "");
  // Search/lookup often includes guests and namesakes. Both ownership checks are mandatory.
  if (raw.kind !== "song" || positiveId(raw.artistId) !== numericArtist || normalize(string(raw.artistName)) !== normalize(artist.name)) return undefined;
  const id = positiveId(raw.trackId); const title = string(raw.trackName).trim(); const duration = Number(raw.trackTimeMillis) / 1000;
  const preview = safeUrl(raw.previewUrl, ["itunes.apple.com", "mzstatic.com"]);
  const url = safeUrl(raw.trackViewUrl, ["music.apple.com", "itunes.apple.com"]);
  const artwork = safeUrl(raw.artworkUrl100, ["mzstatic.com"]);
  if (!id || !title || title.length > 200 || !Number.isFinite(duration) || duration < 30 || duration > 1800 || !preview || !url || rejectVersion(title, string(raw.collectionName))) return undefined;
  const canonical = baseTitle(title);
  const withoutBonusSuffix = canonical.replace(/\s*\(bonus(?:\s+track)?\)\s*$/i, "").trim();
  return { id: `apple:${id}`, title: canonical, aliases: [...new Set([title, canonical, withoutBonusSuffix])], artistId: artist.id, artist: artist.name,
    preview, url, artwork: artwork.replace(/\/100x100bb\./, "/600x600bb."), duration, rank: 0, recordingKey: songKey(liveBase(title), artist.name),
    ...(LIVE_SUFFIX.test(title) || /\blive (?:at|from|in)\b/i.test(string(raw.collectionName)) ? { version: "live" as const } : {}) };
}

function fullArtistPool(artist: Artist, tracks: Track[], facts: CatalogIndex, minimum = MIN_POOL_TRACKS): ArtistPool | undefined {
  const recordingGroups = new Map<string, Track[]>();
  for (const track of tracks) { const key = songKey(track.title, track.artist); recordingGroups.set(key, [...(recordingGroups.get(key) || []), track]); }
  const datedPools = new Map<string, { source: FullStreamRow; tracks: Track[] }>();
  for (const [key, versions] of recordingGroups) {
    // The count source has no duration/ISRC. Reject a title when preview editions have
    // conflicting lengths, or when the source publishes distinct counts for that title.
    const durations = versions.map(track => track.duration);
    if (Math.max(...durations) - Math.min(...durations) > 2.5) continue;
    const sources = facts.fullStreamsByRecording.get(key) || [];
    const latest = sources.map(source => source[3]).sort().at(-1);
    const current = sources.filter(source => source[3] === latest);
    if (!current.length || new Set(current.map(source => `${source[2]}:${source[4]}`)).size !== 1) continue;
    const source = current[0]; const track = versions[0]; const poolKey = `${source[3]}:${source[4]}`;
    const pool = datedPools.get(poolKey) || { source, tracks: [] };
    pool.tracks.push({ ...track, aliases: [...new Set(versions.flatMap(version => version.aliases))], recordingKey: key,
      rank: source[2], rankSourceUrl: source[4], spotifyId: source[5], rankMatch: "artist-title" });
    datedPools.set(poolKey, pool);
  }
  const best = [...datedPools.values()].sort((a, b) => b.tracks.length - a.tracks.length)[0];
  if (!best || best.tracks.length < minimum || (minimum > 0 && new Set(best.tracks.map(track => track.rank)).size < 10)) return undefined;
  return { artist, tracks: best.tracks.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)).slice(0, MAX_POOL_TRACKS), fetchedAt: Date.now(),
    ranking: { kind: "streams", label: "Spotify play-count snapshot", sourceUrl: best.source[4], asOf: best.source[3] } };
}

/** Exact artist ownership first; full artist count pages use unambiguous title evidence.
 * Historical popularity fallback additionally needs catalog durations within2.5 seconds. */
export function rankAppleTracks(artist: Artist, rawTracks: Track[], data?: RankingIndex): ArtistPool {
  const facts = makeIndex(data ?? { version: 1, exportedAt: new Date().toISOString(), sources: [], tracks: [], streams: [] });
  const matching = rawTracks.filter(track => track.artistId === artist.id && normalize(track.artist) === normalize(artist.name) && isPreviewUrl(track.preview) && !rejectVersion(track.title));
  const fullPool = fullArtistPool(artist, matching, facts); if (fullPool) return fullPool;
  const unique = new Map<string, Track>();
  const popularityCandidates: { track: Track; row: PopularityRow; stream?: StreamRow }[] = [];
  // Prefer one historical snapshot. If no source covers20 songs, the fallback explicitly
  // labels its mixed snapshot dates. Stream rankings below always use one dated source.
  const coverageBySource = new Map<number, Set<string>>();
  for (const track of matching) {
    const key = songKey(track.title, track.artist);
    for (const row of facts.byRecording.get(key) || []) {
      if (Math.abs(row[3] - track.duration * 1000) > 2500 || !facts.data.sources[row[5]]?.url) continue;
      const coverage = coverageBySource.get(row[5]) || new Set<string>(); coverage.add(key); coverageBySource.set(row[5], coverage);
    }
  }
  const sourceIndex = [...coverageBySource].sort((a, b) => b[1].size - a[1].size || a[0] - b[0])[0]?.[0];
  const useMixedPopularity = (coverageBySource.get(sourceIndex!)?.size || 0) < MIN_POOL_TRACKS;
  for (const track of matching) {
    const key = songKey(track.title, track.artist);
    const rows = (facts.byRecording.get(key) || []).filter(row => Math.abs(row[3] - track.duration * 1000) <= 2500);
    const row = rows.sort((a, b) => b[4] - a[4] || Math.abs(a[3] - track.duration * 1000) - Math.abs(b[3] - track.duration * 1000))[0];
    if (!row || !facts.data.sources[row[5]]?.url) continue; // Unknown is excluded, never classified as niche.
    const existing = unique.get(key); if (existing && existing.rank >= row[4]) continue;
    unique.set(key, { ...track, rank: row[4], spotifyId: row[0], rankSourceUrl: facts.data.sources[row[5]].url, recordingKey: key, rankMatch: "artist-title-duration" });
  }
  for (const track of unique.values()) {
    const row = (facts.byRecording.get(track.recordingKey!) || []).find(row => row[0] === track.spotifyId)!;
    const streamCandidates = (facts.streamsByRecording.get(track.recordingKey!) || []).filter(stream => Math.abs(stream[2] - track.duration * 1000) <= 2500);
    // Conflicting counts for different recordings make a stream match ambiguous.
    const latest = streamCandidates.map(stream => stream[4]).sort().at(-1);
    const latestRows = streamCandidates.filter(stream => stream[4] === latest);
    // The per-artist page is the broader source when a global chart was fetched that day too.
    const current = latestRows.some(stream => stream[5].includes("/artist/")) ? latestRows.filter(stream => stream[5].includes("/artist/")) : latestRows;
    const stream = current.length && new Set(current.map(value => `${value[3]}:${value[5]}`)).size === 1 ? current[0] : undefined;
    popularityCandidates.push({ track, row, stream });
  }
  const streamGroups = new Map<string, typeof popularityCandidates>();
  for (const item of popularityCandidates) if (item.stream) {
    const key = `${item.stream[4]}:${item.stream[5]}`; streamGroups.set(key, [...(streamGroups.get(key) || []), item]);
  }
  const largestStreamGroup = [...streamGroups.values()].sort((a, b) => b.length - a.length)[0] || [];
  // Missing observations are excluded, never assigned a low score. Require broad coverage
  // so a tiny greatest-hits chart cannot masquerade as an artist's niche catalog.
  const sourcedStreams = largestStreamGroup.length >= MIN_POOL_TRACKS && largestStreamGroup.length >= popularityCandidates.length * 0.8;
  let tracks = sourcedStreams
    ? largestStreamGroup.map(item => ({ ...item.track, rank: item.stream![3], rankSourceUrl: item.stream![5] }))
    : popularityCandidates.flatMap(item => {
      if (useMixedPopularity) return [item.track];
      const rows = (facts.byRecording.get(item.track.recordingKey!) || []).filter(row => row[5] === sourceIndex && Math.abs(row[3] - item.track.duration * 1000) <= 2500).sort((a, b) => b[4] - a[4]);
      const row = rows[0]; return row ? [{ ...item.track, rank: row[4], spotifyId: row[0], rankSourceUrl: facts.data.sources[row[5]].url }] : [];
    });
  tracks = tracks.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)).slice(0, MAX_POOL_TRACKS);
  if (tracks.length < MIN_POOL_TRACKS || new Set(tracks.map(track => track.rank)).size < 10) {
    throw new CatalogError(`We need at least ${MIN_POOL_TRACKS} distinct previewable songs with reliable popularity coverage for ${artist.name}. This catalog currently has ${tracks.length}. Try another artist while the collection grows.`, 422, "insufficient_catalog");
  }
  const source = sourcedStreams ? largestStreamGroup[0].stream! : undefined;
  return {
    artist, tracks, fetchedAt: Date.now(),
    ranking: source
      ? { kind: "streams", label: "Spotify play-count snapshot", sourceUrl: source[5], asOf: source[4] }
      : { kind: "catalog-popularity", label: `Historical Spotify popularity ${useMixedPopularity ? "snapshots · mixed dates" : "snapshot"} · not play counts`, sourceUrl: tracks[0].rankSourceUrl!, asOf: `Historical; exported ${facts.data.exportedAt.slice(0, 10)}` },
  };
}

interface Release { id: string; trackCount: number; name: string }
interface DiscographyState {
  artist: Artist; tracks: Track[]; releases: Release[]; cursor: number;
  manifestLoaded: boolean; limited: boolean; stale: boolean; failedReleases: number; fetchedAt: number;
  capacityReached?: boolean;
}
export interface LoadArtistOptions { continue?: boolean; refresh?: boolean }
const RELEASE_BATCH_BUDGET = 4;

/** Keep the combined response below Apple's 200-result ceiling, including wrappers. */
export function releaseBatch(releases: Release[], cursor: number): Release[] {
  const batch: Release[] = []; let size = 0;
  for (const release of releases.slice(cursor)) {
    const weight = Math.min(200, Math.max(1, release.trackCount)) + 1;
    if (batch.length && (batch.length >= 10 || size + weight > 180)) break;
    batch.push(release); size += weight;
  }
  return batch;
}
function releasesFrom(entries: JsonObject[], artist: Artist): Release[] {
  const numericId = artist.id.slice(6);
  return [...new Map(entries.filter(item => item.wrapperType === "collection" && positiveId(item.artistId) === numericId && normalize(string(item.artistName)) === normalize(artist.name))
    .flatMap(item => {
      const id = positiveId(item.collectionId); const name = string(item.collectionName); const trackCount = Number(item.trackCount);
      return id && name && Number.isFinite(trackCount) && trackCount > 0 ? [{ id, name, trackCount }] : [];
    }).map(release => [release.id, release])).values()];
}
function addTracks(state: DiscographyState, entries: JsonObject[]): void {
  const tracks = entries.map(item => appleTrack(item, state.artist)).filter((track): track is Track => Boolean(track));
  const expanded = [...new Map([...state.tracks, ...tracks].map(track => [track.id, track])).values()];
  // Leave room for the release manifest/metadata below the 4 MiB cache entry cap.
  // Refusing a new batch is explicit; the cursor must never advance past unsaved work.
  if (expanded.length > MAX_POOL_TRACKS || Buffer.byteLength(JSON.stringify(expanded)) > 3_000_000) {
    state.capacityReached = true; state.limited = true; return;
  }
  state.tracks = expanded;
}
function discoveryPool(state: DiscographyState, streams: ArtistStreams | undefined, message?: string): ArtistPool {
  const discoveryTracks = distinctRecordings(state.tracks);
  let measured = 0;
  let pool: ArtistPool = { artist: state.artist, tracks: discoveryTracks, fetchedAt: state.fetchedAt,
    ranking: { kind: "unranked", label: "Discovery mix · popularity unavailable", sourceUrl: state.artist.url, asOf: new Date(state.fetchedAt).toISOString().slice(0, 10) } };
  if (streams) {
    const data: RankingIndex = { version: 1, exportedAt: new Date().toISOString(), tracks: [], streams: [], sources: [],
      fullStreams: streams.observations.map(row => [row.title, streams.artist, row.streams, streams.asOf, streams.sourceUrl, row.spotifyId]) };
    try {
      // Keep conflicting editions available to the identity check instead of hiding them
      // through early deduplication. Unknown counts never become a deep-cut score.
      const ranked = fullArtistPool(state.artist, state.tracks, makeIndex(data), 0);
      const unique = ranked ? distinctRecordings(ranked.tracks) : [];
      measured = unique.length;
      let balanced = false;
      try { tierPools(unique); balanced = true; } catch { /* Discovery keeps every available recording. */ }
      if (ranked && balanced && unique.length >= 20 && unique.length >= discoveryTracks.length * 0.6) {
        pool = { ...ranked, tracks: unique.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)),
          ranking: { ...ranked.ranking, label: "Spotify play counts · Kworb observations" } };
      }
    } catch (error) { if (!(error instanceof CatalogError) || error.code !== "insufficient_catalog") throw error; }
  }
  const hasMore = !state.capacityReached && (!state.manifestLoaded || state.cursor < state.releases.length);
  const limited = state.limited || state.failedReleases > 0;
  // Album artwork belongs to recordings; it must never stand in for the artist.
  pool.artist = { ...state.artist, image: "", imageSourceUrl: undefined, imageAttribution: undefined };
  pool.discoveryTracks = discoveryTracks;
  pool.coverage = { previewable: discoveryTracks.length, ranked: measured,
    releaseCount: state.releases.length, loadedReleases: state.cursor, hasMore,
    status: hasMore ? "partial" : limited ? "provider-limited" : "complete", stale: state.stale || streams?.stale || false,
    message: message || (state.capacityReached ? "This large collection reached the bounded cache capacity. The loaded recordings remain playable; coverage is incomplete." : hasMore ? "More releases are available. Load the rest to widen your next mix." : limited
      ? "Some releases or tracks are unavailable through the US preview provider. This is the available collection, not every recording."
      : "All returned US catalog releases checked; duplicate editions and unavailable previews are excluded.") };
  return pool;
}

async function withArtistPortrait(pool: ArtistPool): Promise<ArtistPool> {
  const portrait = await loadArtistPortrait(pool.artist);
  return { ...pool, artist: { ...pool.artist, image: "", imageSourceUrl: undefined, imageAttribution: undefined, ...portrait } };
}

/** Artist IDs are discovered live. Artist size never depends on a published export. */
export async function loadArtist(id: string, options: LoadArtistOptions = {}): Promise<ArtistPool> {
  if (!/^apple:\d{1,15}$/.test(id) || Number(id.slice(6)) <= 0) throw new CatalogError("Choose an artist from the search results.", 400, "invalid_artist");
  const key = `${CACHE_VERSION}:pool:${id}`;
  return singleFlight(key, async () => {
    const cache = metadataCache();
    const fresh = await cache.get<ArtistPool>(key);
    // Upgrade the old album-art cache without reloading a whole discography.
    if (fresh && !options.refresh && !(options.continue && fresh.value.coverage?.hasMore)) return withArtistPortrait(fresh.value);
    const lease = await cache.acquire(key, 300_000);
    if (!lease) {
      const previous = await cache.get<ArtistPool>(key, true) || await waitForCached<ArtistPool>(cache, key);
      if (previous) return withArtistPortrait({ ...previous.value, coverage: previous.value.coverage ? { ...previous.value.coverage, stale: previous.stale, message: "This artist's collection is being refreshed. Your loaded recordings remain available." } : undefined });
      throw new CatalogError("This artist is already loading. Please try again in a moment.", 429, "provider_busy");
    }
    try {
      // Another instance may have finished between the first read and our lease acquisition.
      const completed = await cache.get<ArtistPool>(key);
      if (completed && !options.refresh && !(options.continue && completed.value.coverage?.hasMore)) return withArtistPortrait(completed.value);
      const stateKey = `${CACHE_VERSION}:discography:${id}`;
      let state = (await cache.get<DiscographyState>(stateKey))?.value;
      if (state && Date.now() - state.fetchedAt >= CACHE_TTL) state = undefined;
      const saveState = (value: DiscographyState) => cache.put(stateKey, value, Math.max(1, value.fetchedAt + CACHE_TTL - Date.now()));
      const numericId = id.slice(6);
      let message: string | undefined;
      try {
        if (!state || options.refresh) {
          const response = await appleRequest("lookup", { id: numericId, entity: "song", limit: "200" });
          const artist = response.entries.filter(item => item.wrapperType === "artist" && positiveId(item.artistId) === numericId).map(appleArtist).find(Boolean);
          if (!artist) throw new CatalogError("This artist is unavailable in the US music catalog. Try another artist.", 404, "artist_unavailable");
          state = { artist, tracks: [], releases: [], cursor: 0, manifestLoaded: false, limited: false, stale: response.stale, failedReleases: 0, fetchedAt: Date.now() };
          addTracks(state, response.entries);
        }
        if (!state.manifestLoaded) {
          const response = await appleRequest("lookup", { id: numericId, entity: "album", limit: "200" });
          state.stale ||= response.stale;
          const allCollections = response.entries.filter(item => item.wrapperType === "collection").length;
          state.releases = releasesFrom(response.entries, state.artist);
          // Apple exposes no supported album-pagination cursor. Surface the ceiling honestly.
          state.limited ||= allCollections >= 200;
          state.manifestLoaded = true;
        }
        for (let batchNo = 0; batchNo < RELEASE_BATCH_BUDGET && !state.capacityReached && state.cursor < state.releases.length; batchNo++) {
          const batch = releaseBatch(state.releases, state.cursor);
          const response = await appleRequest("lookup", { id: batch.map(item => item.id).join(","), entity: "song", limit: "200" });
          state.stale ||= response.stale;
          addTracks(state, response.entries);
          if (state.capacityReached) break;
          for (const release of batch) {
            const returned = response.entries.filter(item => item.kind === "song" && positiveId(item.collectionId) === release.id).length;
            if (returned < release.trackCount) state.failedReleases++;
          }
          state.cursor += batch.length;
          // Checkpoint every completed batch; a timeout never restarts a large discography.
          await saveState(state);
        }
      } catch (error) {
        if (!state) {
          const previous = await cache.get<ArtistPool>(key, true);
          if (previous) return withArtistPortrait({ ...previous.value, coverage: previous.value.coverage ? { ...previous.value.coverage, stale: true, message: "The provider is unavailable. Showing the previous cached collection." } : undefined });
          throw error;
        }
        message = error instanceof CatalogError ? `${error.message} Your loaded songs are still available; retry loading the remaining releases.` : "Some releases could not load. Your available songs are saved; try loading the rest again.";
      }
      await saveState(state);
      let streams: ArtistStreams | undefined;
      try { streams = await loadArtistStreams(state.artist.name); }
      catch { message ||= "Play counts are temporarily unavailable. Discovery mode still uses the available recordings."; }
      const pool = await withArtistPortrait(discoveryPool(state, streams, message));
      // Recover quickly from transient missing rank sources; keep complete metadata for six hours.
      await cache.put(key, pool, Math.max(1, Math.min(pool.ranking.kind === "unranked" || message ? 60_000 : CACHE_TTL, state.fetchedAt + CACHE_TTL - Date.now())));
      return pool;
    } finally { await cache.release(key, lease); }
  });
}
