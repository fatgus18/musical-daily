import type { DatabaseSync } from "node:sqlite";
import { parseArtistDirectory, parseArtistStreams, type ArtistStreams } from "../../shared/music-provider/stream-parsing.ts";
import { cachedText } from "./network.ts";
import { normalize, titleKey } from "./recordings.ts";
import type { Track } from "./store.ts";

const DIRECTORY = "https://kworb.net/spotify/artists.html";

/** Keep the source's own observation date and reject conflicting recording identities. */
export function saveArtistStreams(db: DatabaseSync, data: ArtistStreams, today = new Date().toISOString().slice(0, 10)) {
  if (data.asOf > today || data.asOf < new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10)) return 0;
  const byId = db.prepare("SELECT * FROM tracks WHERE id=?");
  const insert = db.prepare(`INSERT INTO stream_snapshots VALUES(?,?,?,?,?) ON CONFLICT(track_id,observed_on) DO UPDATE SET
    streams=excluded.streams,source=excluded.source,match_method=excluded.match_method
    WHERE excluded.match_method='exact-spotify-id + artist-title' AND stream_snapshots.match_method!='exact-spotify-id + artist-title'`);
  let matched = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const observation of data.observations) {
      const track = byId.get(observation.spotifyId) as unknown as Track | undefined;
      // The page supplies no duration or ISRC. Similar titles across different
      // Spotify editions are insufficient evidence to transfer its total.
      if (!track || normalize(track.primary_artist) !== normalize(data.artist) || titleKey(track.title) !== titleKey(observation.title)) continue;
      insert.run(track.id, data.asOf, observation.streams, data.sourceUrl, "exact-spotify-id + artist-title");
      matched++;
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return matched;
}

/** Extend global-chart coverage with deeper songs from source-identified artist pages. */
export async function importArtistStreams(db: DatabaseSync, artistLimit: number) {
  const today = new Date().toISOString().slice(0, 10);
  const directory = parseArtistDirectory(await cachedText(DIRECTORY, `artist-directory-${today}.html`));
  if (directory.length < 100) throw new Error("Artist stream directory is incomplete; existing observations retained.");
  const byName = new Map<string, typeof directory>();
  for (const artist of directory) {
    const key = normalize(artist.name); byName.set(key, [...(byName.get(key) || []), artist]);
  }
  const candidates = db.prepare(`SELECT primary_artist,artist_key,count(*) tracks,max(popularity) popularity FROM tracks
    WHERE language='en' AND language_review_required=0
    AND artist_key NOT IN (SELECT job_key FROM jobs WHERE kind='artist-streams' AND status='done' AND updated_at>=?)
    GROUP BY artist_key ORDER BY tracks DESC,popularity DESC,artist_key`).all(`${today}T00:00:00.000Z`) as { primary_artist: string; artist_key: string }[];
  const artists = candidates.flatMap(candidate => {
    const matches = byName.get(candidate.artist_key) || [];
    return matches.length === 1 ? [matches[0]] : [];
  }).slice(0, artistLimit);
  const job = db.prepare("INSERT INTO jobs VALUES('artist-streams',?,?,?,?) ON CONFLICT(kind,job_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,details=excluded.details");
  let total = 0;
  for (const [index, artist] of artists.entries()) {
    const url = `https://kworb.net/spotify/artist/${artist.id}_songs.html`;
    try {
      const html = await cachedText(url, `artist-${artist.id}-${today}.html`);
      const data = parseArtistStreams(html, artist.name, url);
      const matched = saveArtistStreams(db, data, today); total += matched;
      job.run(normalize(artist.name), "done", new Date().toISOString(), JSON.stringify({ source: url, asOf: data.asOf, matched }));
      console.log(`[streams ${index + 1}/${artists.length}] ${artist.name}: ${matched} sourced recording matches (${data.asOf})`);
    } catch (error) {
      job.run(normalize(artist.name), "failed", new Date().toISOString(), String(error));
      console.warn(`${artist.name}: ${String(error)} (existing observations retained)`);
    }
    // Sequential requests stay comfortably below the provider's shared app pacing.
    if (index + 1 < artists.length) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log(`Artist stream pages: ${total} recording observations across ${artists.length} artists.`);
}
