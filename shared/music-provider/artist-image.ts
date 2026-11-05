import { metadataCache } from "./provider-cache.ts";
import { boundedResponseText } from "./provider-http.ts";

interface ArtistIdentity { id: string; name: string; url: string }
export interface ArtistPortrait { image: string; imageSourceUrl: string; imageAttribution: "Apple Music" }
const TTL = 7 * 86400_000;
const MISS_TTL = 60 * 60_000;
const RETRY_TTL = 60_000;
const inFlight = new Map<string, Promise<ArtistPortrait | undefined>>();

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "")
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function artistPage(value: unknown, id: string): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || !/^apple:[1-9]\d{0,14}$/.test(id)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== "music.apple.com") return;
    if (!new RegExp(`^/[a-z]{2}/artist/(?:[^/]+/)?${id.slice(6)}/?$`).test(url.pathname)) return;
    url.search = ""; url.hash = ""; return url.href;
  } catch { return; }
}
function portraitUrl(value: unknown, verifiedCircleArtwork = false): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.endsWith(".mzstatic.com")) return;
    // A MusicGroup sometimes has generic/album artwork. Accept the provider's
    // artist-image collection only, never arbitrary album, song or share cards.
    if (!/\/image\/thumb\/(?:AMCArtistImages|MusicArtistImages|ArtistImages)\d*\//.test(url.pathname)
      && !(verifiedCircleArtwork && /\/image\/thumb\/Features\d*\//.test(url.pathname))) return;
    return url.href;
  } catch { return; }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** Older artist photos live in Features, shared with editorial assets. Only the
 * exact artist's circleArtwork proves those are portraits rather than covers. */
function legacyCirclePortrait(html: string, artist: ArtistIdentity): ArtistPortrait | undefined {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']application\/json["']/i.test(match[1]) || !/\bid\s*=\s*["']serialized-server-data["']/i.test(match[1])) continue;
    let data: Record<string, unknown>;
    try { data = object(JSON.parse(match[2])); } catch { continue; }
    for (const page of array(data.data)) for (const section of array(object(object(page).data).sections)) {
      if (object(section).itemKind !== "artistDetailHeader") continue;
      for (const value of array(object(section).items)) {
        const item = object(value); const descriptor = object(item.contentDescriptor);
        if (item.id !== artist.id.slice(6) || typeof item.title !== "string" || normalized(item.title) !== normalized(artist.name)
          || descriptor.kind !== "artist" || object(descriptor.identifiers).storeAdamID !== artist.id.slice(6)) continue;
        const imageSourceUrl = artistPage(descriptor.url, artist.id);
        const template = object(object(item.circleArtwork).dictionary).url;
        if (!imageSourceUrl || typeof template !== "string") continue;
        const rendered = template.replaceAll("{w}", "486").replaceAll("{h}", "486").replaceAll("{c}", "bb").replaceAll("{f}", "png");
        if (/[{}]/.test(rendered)) continue;
        const image = portraitUrl(rendered, true);
        if (image) return { image, imageSourceUrl, imageAttribution: "Apple Music" };
      }
    }
  }
}

/** Identity comes from the selected Apple artist ID, not a name-search result. */
export function parseAppleArtistPortrait(html: string, artist: ArtistIdentity): ArtistPortrait | undefined {
  if (!artistPage(artist.url, artist.id) || html.length > 4_000_000) return;
  for (const match of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let data: unknown;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const objects = Array.isArray(data) ? data : [data];
    for (const item of objects) {
      if (!item || typeof item !== "object" || item["@type"] !== "MusicGroup" || typeof item.name !== "string" || normalized(item.name) !== normalized(artist.name)) continue;
      const imageSourceUrl = artistPage(item.url, artist.id); const image = portraitUrl(item.image);
      if (imageSourceUrl && image) return { image, imageSourceUrl, imageAttribution: "Apple Music" };
    }
  }
  return legacyCirclePortrait(html, artist);
}

/** Optional cosmetic metadata: provider failure never prevents loading songs. */
export async function loadArtistPortrait(artist: ArtistIdentity): Promise<ArtistPortrait | undefined> {
  const url = artistPage(artist.url, artist.id); if (!url) return;
  const key = `artist-portrait:v2:${artist.id}:${normalized(artist.name)}`;
  const cache = metadataCache();
  const cached = cache.get<ArtistPortrait | null>(key); if (cached) return cached.value || undefined;
  const existing = inFlight.get(key); if (existing) return existing;
  if (inFlight.size >= 8) return;
  const pending = (async () => {
    const previous = cache.get<ArtistPortrait | null>(key, true)?.value;
    try {
      const wait = cache.reserve("apple-artist-pages", 250, 1500); if (wait === undefined) return previous || undefined;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(6000), redirect: "error", cache: "no-store" });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Artist page is unavailable.");
      const portrait = parseAppleArtistPortrait(await boundedResponseText(response, 4_000_000), artist);
      cache.put(key, portrait || null, portrait ? TTL : MISS_TTL, portrait ? TTL : 0);
      return portrait;
    } catch {
      // A short negative cache avoids slowing repeated selections during outages.
      cache.put(key, previous || null, RETRY_TTL, previous ? TTL : 0);
      return previous || undefined;
    }
  })();
  inFlight.set(key, pending);
  try { return await pending; } finally { inFlight.delete(key); }
}
