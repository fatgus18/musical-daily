export function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
export function titleKey(value: string): string {
  return normalize(value.replace(/\s*[([](?:feat\.?|featuring|with)\s+[^)\]]+[)\]]/gi, ""));
}
export function isAlternate(value: string): boolean {
  return /\b(remix|remastered|remaster|live|karaoke|cover|instrumental|acoustic|sped up|slowed|nightcore|re recorded|radio edit)\b/i.test(value);
}
export function recordingKey(title: string, artist: string): string { return `${normalize(artist)}::${titleKey(title)}`; }
export function matchRecording(track: { title: string; primary_artist: string; duration_ms: number | null }, hit: { trackName: string; artistName: string; trackTimeMillis: number }): boolean {
  if (isAlternate(hit.trackName) || isAlternate(track.title)) return false;
  const artist = normalize(track.primary_artist);
  const hitArtist = normalize(hit.artistName);
  const sameArtist = hitArtist === artist || hitArtist.startsWith(`${artist} and `) || hitArtist.startsWith(`${artist} feat `);
  return sameArtist && titleKey(track.title) === titleKey(hit.trackName) &&
    !!track.duration_ms && Math.abs(track.duration_ms - hit.trackTimeMillis) <= 2500;
}
