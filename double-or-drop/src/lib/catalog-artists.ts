import { loadArtist, searchArtists, normalize, type ArtistPool, type Artist, type Track } from "../../../shared/music-provider/catalog.ts";
import { artistThemeId, catalogTheme, catalogStatus, filterCatalog, isPreviewUrl, loadCatalog, validateTrack } from "./catalog.ts";
import { publishCatalog } from "./catalog-publication.ts";
import type { Catalog, CatalogSource, CatalogTrack } from "./catalog-types.ts";

export { searchArtists };
export const LIVE_SOURCES: CatalogSource[] = [
  { id: "apple-live-catalog", url: "https://performance-partners.apple.com/search-api", note: "Artist-owned recording metadata and provider preview links discovered through the same bounded provider used by Encore. Availability depends on the US provider catalog; no song language is inferred from artist nationality." },
  { id: "kworb-artist-observations", url: "https://kworb.net/spotify/artists.html", note: "Dated artist stream observations matched by Encore's unambiguous recording identity checks. Unknown popularity is never substituted for a stream count." },
];
const recordingKey = (title: string, artist: string) => `${normalize(artist)}::${normalize(title)}`;

/** Preserve every provider-owned recording and all supported measurements, including unranked songs. */
export function artistPoolTracks(pool: ArtistPool, baseline: CatalogTrack[] = []): CatalogTrack[] {
  if (!pool?.artist?.id || !pool.artist.name || !Array.isArray(pool.tracks)) throw new Error("Music provider returned an invalid artist collection.");
  const ranked = new Map(pool.tracks.map(track => [track.id, track]));
  const all = new Map([...(pool.discoveryTracks || []), ...pool.tracks].map(track => [track.id, track]));
  const facts = new Map<string, CatalogTrack[]>();
  for (const track of baseline) {
    const key = recordingKey(track.title, track.primaryArtist || track.artist);
    const values = facts.get(key) || []; values.push(track); facts.set(key, values);
  }
  const output: CatalogTrack[] = [];
  for (const candidate of all.values()) {
    const track: Track = ranked.get(candidate.id) || candidate;
    if (track.artistId !== pool.artist.id || normalize(track.artist) !== normalize(pool.artist.name) || !isPreviewUrl(track.preview)) continue;
    const item: CatalogTrack = { id: track.id, title: track.title, artist: track.artist, primaryArtist: track.artist,
      artwork: track.artwork || "", sourceUrl: track.url, previewUrl: track.preview, previewSourceUrl: track.url,
      metrics: { duration: { value: track.duration, sourceUrl: track.url, quality: "provider-recording-metadata" } } };
    const matches = (facts.get(recordingKey(track.title, track.artist)) || []).filter(other => other.metrics.duration && Math.abs(other.metrics.duration.value - track.duration) <= 2.5);
    // Cross-provider metadata is transferred only when the recording identity and measured values agree.
    for (const metric of ["tempo", "streams"] as const) {
      const values = matches.flatMap(other => other.metrics[metric] ? [other.metrics[metric]!] : []);
      if (values.length && new Set(values.map(value => `${value.value}:${value.asOf || ""}`)).size === 1) item.metrics[metric] = { ...values[0] };
    }
    if (matches.length && new Set(matches.map(other => other.genre)).size === 1) item.genre = matches[0].genre;
    if (pool.ranking.kind === "streams" && Number.isSafeInteger(track.rank) && track.rank > 0 && track.rankSourceUrl && track.rankMatch) {
      item.metrics.streams = { value: track.rank, sourceUrl: track.rankSourceUrl, asOf: pool.ranking.asOf, quality: `observed-count-${track.rankMatch}` };
    }
    validateTrack(item); output.push(item);
  }
  return output;
}

export async function loadArtistCollection(artistId: string, continueLoading = false) {
  const baseline = loadCatalog();
  const pool = await loadArtist(artistId, { continue: continueLoading });
  const id = artistThemeId(pool.artist.name);
  const tracks = [...new Map([...filterCatalog(baseline, id), ...artistPoolTracks(pool, baseline.tracks)].map(track => [track.id, track])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const theme = catalogTheme(id, pool.artist.name, tracks);
  if (!theme.metrics.length) throw Object.assign(new Error("This artist needs two different songs with comparable measurements. Load more releases or choose another artist."), { status: 422 });
  const catalog = await publishCatalog(tracks, [...baseline.sources, ...LIVE_SOURCES], undefined, false);
  return { catalogVersion: catalog.version, catalog: catalogStatus(catalog), theme, artist: pool.artist, coverage: pool.coverage };
}

export interface ArtistCollection { catalogVersion: string; theme: ReturnType<typeof catalogTheme>; artist: Artist; coverage?: ArtistPool["coverage"] }
export type { Catalog };
