import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Catalog, CatalogTheme, CatalogTrack, Metric } from "./catalog-types.ts";
import { findEligiblePair, METRICS as PLAYABLE_METRICS } from "./rules.ts";

export type { Catalog, CatalogTheme, CatalogTrack, Metric, MetricValue } from "./catalog-types.ts";

export const METRICS: Metric[] = ["streams", "duration", "tempo", "year"];
const GENRES: Record<string, string> = { pop: "Pop party", rock: "Rock anthems", "hip-hop": "Hip-hop", rnb: "R&B & soul", electronic: "Dance floor", country: "Country roads", jazz: "Jazz club", folk: "Acoustic afternoon" };
const cache = new Map<string, Catalog>();
const indexes = new WeakMap<Catalog, Map<string, CatalogTrack[]>>();
// A corruption / resource bound, never a popularity-based selection or song cap.
export const MAX_CATALOG_BYTES = 128 * 1024 * 1024;
export const MAX_CATALOG_TRACKS = 250_000;

export function catalogVersion(tracks: CatalogTrack[], sources: Catalog["sources"]): string {
  return createHash("sha256").update(JSON.stringify({ tracks, sources })).digest("hex").slice(0, 16);
}

function https(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

export function isPreviewUrl(value: unknown): value is string {
  if (!https(value) || value.length > 4096) return false;
  const host = new URL(value).hostname;
  return ["itunes.apple.com", "mzstatic.com", "dzcdn.net"].some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function validateTrack(track: CatalogTrack): void {
  if (!track || !/^[A-Za-z0-9:_-]{1,100}$/.test(track.id) || typeof track.title !== "string" || !track.title.trim() || track.title.length > 250 || typeof track.artist !== "string" || !track.artist.trim() || track.artist.length > 500 || !https(track.sourceUrl)) throw new Error("Catalog recording identity or source is invalid.");
  if (typeof track.artwork !== "string" || (track.artwork && !https(track.artwork))) throw new Error("Catalog artwork must use HTTPS.");
  if (track.previewUrl != null && (!isPreviewUrl(track.previewUrl) || !https(track.previewSourceUrl))) throw new Error("Preview links require an approved HTTPS music provider and attribution.");
  if (track.languageSource != null && !https(track.languageSource)) throw new Error("Language evidence must use HTTPS.");
  if (track.popularity != null && (!Number.isFinite(track.popularity) || track.popularity < 0 || track.popularity > 100)) throw new Error("Popularity must be a sourced 0–100 value.");
  if (!track.metrics || !Object.keys(track.metrics).length || Object.keys(track.metrics).some(key => !METRICS.includes(key as Metric))) throw new Error("A recording needs known comparison metrics.");
  for (const metric of METRICS) {
    const data = track.metrics[metric];
    if (!data) continue;
    if (!Number.isFinite(data.value) || !https(data.sourceUrl)) throw new Error("Comparison values require a finite number and HTTPS evidence.");
    if (data.asOf && (!/^\d{4}-\d{2}-\d{2}$/.test(data.asOf) || !Number.isFinite(Date.parse(data.asOf)) || new Date(data.asOf).toISOString().slice(0, 10) !== data.asOf)) throw new Error("Invalid observation date.");
    if (metric === "streams" && (!Number.isSafeInteger(data.value) || data.value <= 0 || !data.asOf)) throw new Error("Streams need a positive observed count and date.");
    if (metric === "duration" && (data.value < 30 || data.value > 1800)) throw new Error("Recording duration is out of range.");
    if (metric === "tempo" && (data.value < 40 || data.value > 240)) throw new Error("Tempo is out of range.");
    if (metric === "year" && (!Number.isInteger(data.value) || data.value < 1900 || data.value > new Date().getUTCFullYear() || data.quality !== "verified-original-release")) throw new Error("Year comparisons require verified original-release evidence.");
  }
  if (track.decade != null && (!track.metrics.year || track.decade !== Math.floor(track.metrics.year.value / 10) * 10)) throw new Error("Decade requires an evidenced original year.");
}

export function validateCatalog(catalog: Catalog): void {
  if (catalog.schema !== 1 || !/^[a-f0-9]{16}$/.test(catalog.version) || !Array.isArray(catalog.tracks) || catalog.tracks.length < 2 || catalog.tracks.length > MAX_CATALOG_TRACKS || !Array.isArray(catalog.sources) || !catalog.sources.length || !Number.isFinite(Date.parse(catalog.createdAt))) throw new Error("Invalid catalog release.");
  const seen = new Set<string>();
  for (const track of catalog.tracks) { validateTrack(track); if (seen.has(track.id)) throw new Error("Duplicate recording IDs."); seen.add(track.id); }
  if (catalog.sources.some(source => !source.id || !https(source.url) || !source.note)) throw new Error("Catalog sources must be attributed.");
  if (catalogVersion(catalog.tracks, catalog.sources) !== catalog.version) throw new Error("Catalog content does not match its immutable version.");
  if (!METRICS.some(metric => eligibleThemeMetric(catalog.tracks, metric))) throw new Error("Catalog needs at least two distinct comparable recordings.");
}

/** A version is pinned when the run begins. Refreshing the manifest never changes a run. */
export function loadCatalog(version?: string): Catalog {
  const root = process.env.DOUBLE_DROP_CATALOG_DIR || resolve(process.cwd(), "data");
  const selected = version ?? (JSON.parse(readFileSync(resolve(root, "catalog-releases.json"), "utf8")) as { current: string }).current;
  if (!/^[a-f0-9]{16}$/.test(selected)) throw new Error("Unknown catalog version.");
  let catalog = cache.get(`${root}:${selected}`);
  if (!catalog) {
    const raw = readFileSync(resolve(root, "catalog-releases", `${selected}.json`));
    if (raw.byteLength > MAX_CATALOG_BYTES) throw new Error("Catalog exceeds its metadata budget.");
    catalog = JSON.parse(raw.toString("utf8")) as Catalog;
    validateCatalog(catalog);
    if (catalog.version !== selected) throw new Error("Catalog version mismatch.");
    cache.set(`${root}:${selected}`, catalog);
    // Old runs can always reload their immutable version from disk.
    while (cache.size > 3) cache.delete(cache.keys().next().value!);
  }
  return catalog;
}
export const readCatalog = loadCatalog;

export function artistThemeId(artist: string): string {
  return `artist:${artist.normalize("NFKC").trim().toLocaleLowerCase("en-US")}`;
}

function themeIndex(catalog: Catalog): Map<string, CatalogTrack[]> {
  let index = indexes.get(catalog);
  if (index) return index;
  index = new Map([["all", catalog.tracks]]);
  for (const track of catalog.tracks) {
    const keys = [artistThemeId(track.primaryArtist || track.artist), ...(track.genre ? [track.genre] : []), ...(track.decade != null ? [`decade:${track.decade}`] : [])];
    for (const key of keys) { const group = index.get(key) || []; group.push(track); index.set(key, group); }
  }
  indexes.set(catalog, index); return index;
}

export function filterCatalog(catalog: Catalog, themeId = "all"): CatalogTrack[] {
  return themeIndex(catalog).get(themeId) || [];
}

export function eligibleThemeMetric(tracks: CatalogTrack[], metric: Metric): boolean {
  return Boolean(findEligiblePair(tracks, metric));
}

export function catalogTheme(id: string, label: string, tracks: CatalogTrack[]): CatalogTheme {
  return { id, label, trackCount: tracks.length, metrics: PLAYABLE_METRICS.filter(metric => eligibleThemeMetric(tracks, metric)) };
}
const theme = catalogTheme;

export function listThemes(catalog = loadCatalog()): CatalogTheme[] {
  return [theme("all", "Anything goes", catalog.tracks), ...Object.entries(GENRES).map(([id, label]) => theme(id, label, filterCatalog(catalog, id))), ...[...new Set(catalog.tracks.flatMap(track => track.decade == null ? [] : [track.decade]))].sort().map(decade => theme(`decade:${decade}`, `${decade}s`, filterCatalog(catalog, `decade:${decade}`)))].filter(item => item.metrics.length);
}

export function listArtistThemes(catalog = loadCatalog(), query = ""): CatalogTheme[] {
  const search = query.toLocaleLowerCase("en-US");
  return [...themeIndex(catalog)].filter(([id]) => id.startsWith("artist:") && (!search || id.includes(search)))
    .map(([id, tracks]) => theme(id, tracks[0].primaryArtist || tracks[0].artist, tracks))
    .filter(item => item.metrics.length).sort((a, b) => b.trackCount - a.trackCount || a.label.localeCompare(b.label));
}

export function catalogStatus(catalog = loadCatalog()) {
  return { version: catalog.version, createdAt: catalog.createdAt, tracks: catalog.tracks.length, artists: new Set(catalog.tracks.map(track => track.primaryArtist || track.artist)).size, metrics: Object.fromEntries(PLAYABLE_METRICS.map(metric => [metric, catalog.tracks.filter(track => track.metrics[metric]).length])), themes: listThemes(catalog), sources: catalog.sources };
}
