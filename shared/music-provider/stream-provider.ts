import { metadataCache, waitForCached } from "./provider-cache.ts";
import { boundedResponseText } from "./provider-http.ts";

export interface StreamObservation { title: string; streams: number; spotifyId: string }
export interface ArtistStreams { artist: string; sourceUrl: string; asOf: string; observations: StreamObservation[]; stale?: boolean }
interface DirectoryArtist { id: string; name: string }
const DIRECTORY = "https://kworb.net/spotify/artists.html";
const TTL = 24 * 3600_000;
const pending = new Map<string, Promise<unknown>>();
const norm = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
function decode(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, entity: string) => {
    const code = entity.toLowerCase().startsWith("x") ? parseInt(entity.slice(1), 16) : Number(entity);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
}
export function parseArtistDirectory(html: string): DirectoryArtist[] {
  const rows = [...html.matchAll(/href="(?:\/spotify\/)?artist\/([A-Za-z0-9]{22})(?:_songs)?\.html"[^>]*>([^<]+)<\/a>/g)]
    .map(match => ({ id: match[1], name: decode(match[2]) })).filter(row => row.name.length > 0 && row.name.length <= 180);
  return [...new Map(rows.map(row => [`${row.id}:${norm(row.name)}`, row])).values()];
}
export function parseArtistStreams(html: string, artist: string, sourceUrl: string): ArtistStreams {
  const pageTitle = decode(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "");
  if (norm(pageTitle) !== norm(`${artist} - Spotify Top Songs`)) throw new Error("Stream artist identity mismatch.");
  const date = html.match(/Last updated:\s*(\d{4})\/(\d{2})\/(\d{2})/)?.slice(1).join("-");
  if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Missing or invalid stream observation date.");
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].find(match => /<th[^>]*>Song Title<\/th>/i.test(match[1]) && /<th[^>]*>Streams<\/th>/i.test(match[1]))?.[1];
  if (!table) throw new Error("Stream table format changed.");
  const observations: StreamObservation[] = [];
  for (const match of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1]);
    if (cells.length < 2) continue;
    const title = decode(cells[0]); const streams = Number(decode(cells[1]).replaceAll(",", ""));
    const spotifyId = cells[0].match(/https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]{22})(?:[?"/]|$)/)?.[1];
    // The source marks guest appearances with *. Only the selected lead artist counts.
    if (!title || title.startsWith("*") || title.length > 200 || !Number.isSafeInteger(streams) || streams <= 0 || !spotifyId) continue;
    observations.push({ title, streams, spotifyId });
  }
  if (!observations.length) throw new Error("No usable play-count observations.");
  return { artist, sourceUrl, asOf: date, observations };
}
async function html(url: string): Promise<string> {
  const delay = await metadataCache().reserve("kworb", 700, 5000);
  if (delay === undefined) throw new Error("Stream source is busy.");
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const result = await fetch(url, { signal: AbortSignal.timeout(12_000), redirect: "error", cache: "no-store", headers: { accept: "text/html" } });
  if (!result.ok) throw new Error("Stream source unavailable.");
  return boundedResponseText(result, 8_000_000);
}
async function cached<T>(key: string, request: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  const active = pending.get(key); if (active) return active as Promise<{ value: T; stale: boolean }>;
  const promise = (async () => {
    const cache = metadataCache(); const fresh = await cache.get<T>(key); if (fresh) return fresh;
    const failure = await cache.get<boolean>(`${key}:failed`);
    if (failure) { const previous = await cache.get<T>(key, true); if (previous) return previous; throw new Error("Stream source cooling down."); }
    const lease = await cache.acquire(key, 25_000);
    if (!lease) {
      const previous = await cache.get<T>(key, true) || await waitForCached<T>(cache, key);
      if (previous) return previous;
      throw new Error("Stream source is busy.");
    }
    try {
      const completed = await cache.get<T>(key); if (completed) return completed;
      const value = await request(); await cache.put(key, value, TTL); return { value, stale: false };
    }
    catch (error) { await cache.put(`${key}:failed`, true, 60_000, 0); const previous = await cache.get<T>(key, true); if (previous) return previous; throw error; }
    finally { await cache.release(key, lease); }
  })();
  pending.set(key, promise); try { return await promise; } finally { pending.delete(key); }
}
/** Live per-request artist discovery; no list of supported artists or local song export. */
export async function loadArtistStreams(name: string): Promise<ArtistStreams | undefined> {
  const directory = await cached("streams-v1:directory", async () => {
    const artists = parseArtistDirectory(await html(DIRECTORY));
    if (artists.length < 100) throw new Error("Stream directory format changed."); return artists;
  });
  const matches = directory.value.filter(artist => norm(artist.name) === norm(name));
  if (new Set(matches.map(artist => artist.id)).size !== 1) return undefined;
  const artist = matches[0]; const sourceUrl = `https://kworb.net/spotify/artist/${artist.id}_songs.html`;
  const result = await cached(`streams-v1:artist:${artist.id}`, async () => parseArtistStreams(await html(sourceUrl), name, sourceUrl));
  return { ...result.value, stale: result.stale || directory.stale };
}
