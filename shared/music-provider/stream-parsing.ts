export interface StreamObservation { title: string; streams: number; spotifyId: string }
export interface ArtistStreams { artist: string; sourceUrl: string; asOf: string; observations: StreamObservation[]; stale?: boolean }
interface DirectoryArtist { id: string; name: string }
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
