import { metadataCache, waitForCached } from "./provider-cache.ts";
import { boundedResponseText } from "./provider-http.ts";

export type { StreamObservation, ArtistStreams } from "./stream-parsing.ts";
export { parseArtistDirectory, parseArtistStreams } from "./stream-parsing.ts";
import { parseArtistDirectory, parseArtistStreams, type ArtistStreams } from "./stream-parsing.ts";
const DIRECTORY = "https://kworb.net/spotify/artists.html";
const TTL = 24 * 3600_000;
const pending = new Map<string, Promise<unknown>>();
const norm = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
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
/** Shared live discovery for stream matching and random artist rooms. */
export async function loadArtistDirectory():Promise<{value:{id:string;name:string}[];stale:boolean}> {
  return cached("streams-v1:directory", async () => {
    const artists = parseArtistDirectory(await html(DIRECTORY));
    if (artists.length < 100) throw new Error("Stream directory format changed."); return artists;
  });
}
/** Live per-request artist discovery; no list of supported artists or local song export. */
export async function loadArtistStreams(name: string): Promise<ArtistStreams | undefined> {
  const directory = await loadArtistDirectory();
  const matches = directory.value.filter(artist => norm(artist.name) === norm(name));
  if (new Set(matches.map(artist => artist.id)).size !== 1) return undefined;
  const artist = matches[0]; const sourceUrl = `https://kworb.net/spotify/artist/${artist.id}_songs.html`;
  const result = await cached(`streams-v1:artist:${artist.id}`, async () => parseArtistStreams(await html(sourceUrl), name, sourceUrl));
  return { ...result.value, stale: result.stale || directory.stale };
}
