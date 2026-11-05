import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TrackRecord } from "./tracks";
import { choosePreview, recordingTitle, safePreviewUrl, type AppleSong } from "./preview-matching";
import { knownTrackArtwork, resolveTrackArtwork } from "./artwork";

export interface TrackMedia {
  albumArtUrl?: string;
  previewUrl?: string;
  previewSourceUrl?: string;
  previewStatus?: "available" | "unavailable" | "retry";
}
interface CacheEntry { expiresAt: number; checkedAt: number; repairedAt?: number; media: TrackMedia }
const directory = resolve(process.cwd(), "data/runtime");
const cacheFile = resolve(directory, "preview-media-v1.json");
const entries = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<TrackMedia>>();
let loaded = false;
let nextRequestAt = 0;

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = JSON.parse(readFileSync(cacheFile, "utf8")) as [string, CacheEntry][];
    for (const [key, entry] of stored.slice(-500)) if (entry.expiresAt > Date.now()) entries.set(key, entry);
  } catch { /* Missing/corrupt caches can always be rebuilt. */ }
}

function saveCache(id: string, media: TrackMedia, repair: boolean) {
  const now = Date.now();
  for (const [key, value] of entries) if (value.expiresAt <= now) entries.delete(key);
  entries.delete(id);
  entries.set(id, { checkedAt: now, repairedAt: repair ? now : undefined, expiresAt: now + (media.previewStatus === "retry" ? 60_000 : media.previewUrl ? 86_400_000 : 21_600_000), media });
  while (entries.size > 500) entries.delete(entries.keys().next().value!);
  try {
    mkdirSync(directory, { recursive: true });
    const temporary = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...entries]));
    renameSync(temporary, cacheFile);
  } catch { /* Read-only/serverless deployments retain the bounded memory cache. */ }
}

export function cachedTrackMedia(track: TrackRecord): TrackMedia {
  loadCache();
  const albumArtUrl = knownTrackArtwork(track)?.url;
  const hit = entries.get(track.id);
  if (hit && hit.expiresAt > Date.now()) return { ...hit.media, albumArtUrl: albumArtUrl || hit.media.albumArtUrl };
  const previewUrl = safePreviewUrl(track.previewUrl);
  return { albumArtUrl, previewUrl, previewStatus: previewUrl ? "available" : undefined };
}

/** Artwork is resolved separately from optional previews; boards keep their IDs. */
export async function boardTrackMedia(track: TrackRecord): Promise<TrackMedia> {
  const media = cachedTrackMedia(track);
  if (media.albumArtUrl) return media;
  return { ...media, albumArtUrl: (await resolveTrackArtwork(track))?.url };
}

export async function resolveTrackPreview(track: TrackRecord, repair = false): Promise<TrackMedia> {
  const cached = cachedTrackMedia(track);
  const stored = entries.get(track.id);
  if (!repair && (cached.previewUrl || (stored && stored.expiresAt > Date.now()))) return cached;
  // An explicit retry may refresh a missing URL, but repeated clicks cannot
  // bypass the request budget. Playback failures exclude the last URL.
  if (repair && stored && ((stored.repairedAt && Date.now() - stored.repairedAt < 30_000) || (!stored.media.previewUrl && Date.now() - stored.checkedAt < 30_000))) return cached;
  const existing = pending.get(track.id);
  if (existing) return existing;
  if (pending.size >= 8 || nextRequestAt - Date.now() > 15_000) return { ...cached, previewUrl: undefined, previewStatus: "retry" };
  const excludedUrl = repair ? cached.previewUrl : undefined;
  const operation = (async (): Promise<TrackMedia> => {
    let hadFailure = false;
    // Only store metadata/URLs. No audio downloads, proxies, or full-song files.
    for (const country of ["US", "GB"]) {
      const wait = Math.max(0, nextRequestAt - Date.now());
      nextRequestAt = Date.now() + wait + 3_200;
      if (wait) await new Promise(resolveWait => setTimeout(resolveWait, wait));
      try {
        const url = new URL("https://itunes.apple.com/search");
        url.search = new URLSearchParams({ term: `${recordingTitle(track.title)} ${track.artist}`, entity: "song", media: "music", country, limit: "50" }).toString();
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(7_000) });
        if (!response.ok) { hadFailure = true; if (response.status === 429) break; continue; }
        const data = await response.json();
        const hit = choosePreview(track, Array.isArray(data.results) ? data.results as AppleSong[] : [], excludedUrl);
        if (!hit) continue;
        const media: TrackMedia = {
          albumArtUrl: cached.albumArtUrl || hit.artworkUrl100?.replace("100x100bb", "600x600bb"),
          previewUrl: safePreviewUrl(hit.previewUrl),
          previewSourceUrl: hit.trackViewUrl,
          previewStatus: "available",
        };
        saveCache(track.id, media, repair);
        return media;
      } catch { hadFailure = true; }
    }
    const media: TrackMedia = { albumArtUrl: cached.albumArtUrl, previewStatus: hadFailure ? "retry" : "unavailable" };
    saveCache(track.id, media, repair);
    return media;
  })();
  pending.set(track.id, operation);
  try { return await operation; } finally { pending.delete(track.id); }
}
