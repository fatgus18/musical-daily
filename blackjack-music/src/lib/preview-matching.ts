/** Identity matching deliberately keeps live, acoustic, remix and rerecorded titles distinct. */
export interface PreviewIdentity {
  title: string;
  artist: string;
  durationMs?: number;
}

export interface AppleSong {
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
  trackTimeMillis?: number;
}

const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const feature = /[([](?:feat\.?|ft\.?|featuring|with)\s+([^\])]+)[\])]/gi;

export function recordingTitle(value: string): string {
  return value.replace(feature, "").replace(/\s*[-–(\[]\s*(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:19|20)\d{2})?\s*[)\]]?$/i, "").trim();
}

function credits(title: string, artist: string): string[] {
  const featured = [...title.matchAll(feature)].map(match => match[1]);
  // Split only for a full set comparison, never accept an arbitrary substring or
  // the first comma-separated word (e.g. Tyler, The Creator).
  return [...new Set([artist, ...featured].flatMap(value => value.split(/\s+(?:&|and|feat\.?|ft\.?|featuring|with|x)\s+|;\s*|,\s*/i)).map(normalize).filter(Boolean))].sort();
}

export function isMatchingRecording(track: PreviewIdentity, candidate: AppleSong): boolean {
  if (candidate.kind !== "song" || !candidate.trackName || !candidate.artistName) return false;
  if (normalize(recordingTitle(track.title)) !== normalize(recordingTitle(candidate.trackName))) return false;
  const expected = credits(track.title, track.artist);
  const actual = credits(candidate.trackName, candidate.artistName);
  const expectedGuests = credits(track.title, "");
  const actualGuests = credits(candidate.trackName, "");
  if (expectedGuests.length && actualGuests.length && expectedGuests.join("|") !== actualGuests.join("|")) return false;
  // Exact artist text allows platforms that omit a featured credit in the title;
  // otherwise all credited names must agree across artist and title fields.
  const sameArtist = normalize(track.artist) === normalize(candidate.artistName);
  if (!sameArtist && (expected.length !== actual.length || expected.some((name, index) => name !== actual[index]))) return false;
  if (track.durationMs && candidate.trackTimeMillis && Math.abs(track.durationMs - candidate.trackTimeMillis) > 5_000) return false;
  return true;
}

export function safePreviewUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return;
    if (host.endsWith(".mzstatic.com") || host.endsWith(".itunes.apple.com") || host === "p.scdn.co" || host.endsWith(".dzcdn.net")) return url.href;
  } catch { /* Invalid provider URL. */ }
}

export function choosePreview(track: PreviewIdentity, candidates: AppleSong[], excludedUrl?: string): AppleSong | undefined {
  return candidates.filter(candidate => isMatchingRecording(track, candidate) && safePreviewUrl(candidate.previewUrl) && candidate.previewUrl !== excludedUrl)
    .sort((a, b) => Number(normalize(b.trackName!) === normalize(track.title)) - Number(normalize(a.trackName!) === normalize(track.title)))[0];
}
