import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TrackRecord } from "./tracks";
import { isMatchingRecording, recordingTitle, type AppleSong } from "./preview-matching";
import legacyArtwork from "../../data/legacy-artwork.json";

export interface TrackArtwork { url: string; sourceUrl: string; checkedAt: string }
interface ArtworkCache { checkedAt: number; artwork?: TrackArtwork }
const runtimeFile = process.env.BLACKJACK_ARTWORK_CACHE_PATH || resolve(process.cwd(), "data/runtime/artwork-v1.json");
const publishedFile = resolve(process.cwd(), "data/artwork.json");
const entries = new Map<string, ArtworkCache>();
const published = new Map<string, TrackArtwork>();
const pending = new Map<string, Promise<TrackArtwork | undefined>>();
let loaded = false;
let appleRequestAt = 0;

/** Spotify uses both its original CDN and newer spotifycdn.com image hosts. */
export function safeArtworkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    const host = url.hostname.toLowerCase();
    if (host === "i.scdn.co" || /^image-cdn-[a-z0-9-]+\.spotifycdn\.com$/.test(host) || host.endsWith(".mzstatic.com")) return url.href;
  } catch { /* Reject invalid or untrusted image URLs. */ }
}

function readArtwork(value: unknown): TrackArtwork | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as Partial<TrackArtwork>;
  const url = safeArtworkUrl(entry.url);
  if (url && typeof entry.sourceUrl === "string" && typeof entry.checkedAt === "string") return { url, sourceUrl: entry.sourceUrl, checkedAt: entry.checkedAt };
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const file = JSON.parse(readFileSync(publishedFile, "utf8"));
    if (file.schema === 1) for (const [id, value] of Object.entries(file.tracks || {})) {
      const artwork = readArtwork(value);
      if (artwork) published.set(id, artwork);
    }
  } catch { /* New deployments can resolve missing metadata on demand. */ }
  try {
    // This disposable, optionally external cache is created at runtime. The
    // deployable artwork snapshot above is the only artwork data to bundle.
    for (const [id, entry] of (JSON.parse(readFileSync(/*turbopackIgnore: true*/ runtimeFile, "utf8")) as [string, ArtworkCache][]).slice(-2_000)) {
      if (Number.isFinite(entry.checkedAt)) entries.set(id, { checkedAt: entry.checkedAt, artwork: readArtwork(entry.artwork) });
    }
  } catch { /* Keep the published covers available if a runtime cache is missing. */ }
}

function save(id: string, artwork?: TrackArtwork) {
  entries.delete(id);
  entries.set(id, { checkedAt: Date.now(), artwork });
  while (entries.size > 2_000) entries.delete(entries.keys().next().value!);
  try {
    mkdirSync(resolve(runtimeFile, ".."), { recursive: true });
    const temporary = `${runtimeFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...entries]));
    renameSync(temporary, runtimeFile);
  } catch { /* Read-only hosts still retain the bounded in-memory cache. */ }
}

/** Four audited historical metadata errors; never relax general recording matching. */
export function reviewedLegacyArtwork(track: TrackRecord): TrackArtwork | undefined {
  const review = legacyArtwork.tracks.find(item => item.id === track.id && item.title === track.title && item.artist === track.artist && item.releaseYear === track.releaseYear);
  if (!review) return;
  const url = safeArtworkUrl(review.url);
  if (url) return { url, sourceUrl: review.sourceUrl, checkedAt: review.verifiedAt };
}

export function knownTrackArtwork(track: TrackRecord, excludedUrl?: string): TrackArtwork | undefined {
  load();
  const snapshot = published.get(track.id);
  const runtime = entries.get(track.id)?.artwork;
  const embedded = safeArtworkUrl(track.albumArtUrl);
  return [runtime, snapshot, reviewedLegacyArtwork(track), embedded ? { url: embedded, sourceUrl: `https://open.spotify.com/track/${track.id}`, checkedAt: "catalog" } : undefined]
    .find(artwork => artwork && artwork.url !== excludedUrl);
}

export function alternateSpotifyArtwork(value: string): string | undefined {
  const safe = safeArtworkUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  if (!/^\/image\/[a-f0-9]{40}$/.test(url.pathname)) return;
  if (url.hostname === "i.scdn.co") return `https://image-cdn-ak.spotifycdn.com${url.pathname}`;
  if (url.hostname.endsWith(".spotifycdn.com")) return `https://i.scdn.co${url.pathname}`;
}

export async function resolveTrackArtwork(track: TrackRecord, excludedUrl?: string): Promise<TrackArtwork | undefined> {
  const known = knownTrackArtwork(track, excludedUrl);
  if (known) return known;
  if (excludedUrl) {
    const alternate = alternateSpotifyArtwork(excludedUrl);
    if (alternate) return { url: alternate, sourceUrl: `https://open.spotify.com/track/${track.id}`, checkedAt: new Date().toISOString() };
  }
  const cached = entries.get(track.id);
  if (!excludedUrl && cached && Date.now() - cached.checkedAt < 60_000) return cached.artwork;
  const key = `${track.id}:${excludedUrl || ""}`;
  const existing = pending.get(key);
  if (existing) return existing;
  // Bound unknown/repair requests; the shipped metadata covers published boards.
  if (pending.size >= 12) return;
  const operation = (async () => {
    try {
      const response = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${encodeURIComponent(track.id)}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const data = await response.json();
        const url = safeArtworkUrl(data.thumbnail_url);
        if (url && url !== excludedUrl) {
          const artwork = { url, sourceUrl: `https://open.spotify.com/track/${track.id}`, checkedAt: new Date().toISOString() };
          save(track.id, artwork);
          return artwork;
        }
      }
    } catch { /* Try exact recording metadata from Apple next. */ }
    // Do not mistake a similarly named cover/live/remix for the same recording.
    const wait = Math.max(0, appleRequestAt - Date.now());
    if (wait <= 12_000) {
      appleRequestAt = Date.now() + wait + 3_200;
      if (wait) await new Promise(done => setTimeout(done, wait));
      try {
        const query = new URLSearchParams({ term: `${recordingTitle(track.title)} ${track.artist}`, entity: "song", media: "music", country: "US", limit: "50" });
        const response = await fetch(`https://itunes.apple.com/search?${query}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          const data = await response.json();
          const match = (Array.isArray(data.results) ? data.results as AppleSong[] : []).find(song => isMatchingRecording(track, song) && safeArtworkUrl(song.artworkUrl100) && song.artworkUrl100?.replace("100x100bb", "600x600bb") !== excludedUrl);
          const url = safeArtworkUrl(match?.artworkUrl100?.replace("100x100bb", "600x600bb"));
          if (url) {
            const artwork = { url, sourceUrl: match?.trackViewUrl || `https://open.spotify.com/track/${track.id}`, checkedAt: new Date().toISOString() };
            save(track.id, artwork);
            return artwork;
          }
        }
      } catch { /* A missing lookup is retryable and never changes the daily board. */ }
    }
    if (!excludedUrl) save(track.id);
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}
