// Private local test utility. This is never imported by application code and
// refuses any database outside the gateway's disposable directory.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MetadataCache } from "../../../shared/music-provider/provider-cache.ts";

const root = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(join(root, "test-results-accounts/fixture.json"), "utf8"));
const directory = relative(tmpdir(), manifest.temporary);
if (manifest.localFixture !== true || manifest.origin !== "https://localhost:3100" || isAbsolute(directory) || directory.startsWith("..") || !directory.startsWith("musical-daily-services-smoke-")) throw new Error("Rooms QA requires the disposable local HTTPS fixture.");
const localPath = value => {
  const path = relative(manifest.temporary, value);
  if (!path || isAbsolute(path) || path.startsWith("..")) throw new Error("Room fixture path escaped its temporary directory.");
  return value;
};
localPath(manifest.encore);
const operation = process.argv[2];

if (operation === "catalog") {
  // Real song titles and artist identity, test-only media. Browser tests replace
  // only /rooms/audio with a generated WAV; all gameplay APIs remain real.
  const names = ["Hello", "Rolling in the Deep", "Someone Like You", "Set Fire to the Rain", "Easy On Me", "Skyfall", "When We Were Young", "Send My Love (To Your New Lover)", "Water Under the Bridge", "Rumour Has It", "Chasing Pavements", "Make You Feel My Love", "All I Ask", "Turning Tables", "Oh My God", "Love in the Dark", "Hometown Glory", "I Drink Wine", "Don't You Remember", "One and Only", "Million Years Ago", "Remedy", "Love Is a Game", "To Be Loved", "Daydreamer", "Cold Shoulder", "Right as Rain", "My Little Love", "Can I Get It", "He Won't Go"];
  const artist = { id: "apple:262836961", name: "Adele", image: "", url: "https://music.apple.com/us/artist/adele/262836961" };
  const tracks = names.map((title, index) => ({ id: `qa-adele-${index}`, title, aliases: [], artistId: artist.id, artist: artist.name, preview: `https://cdnt-preview.dzcdn.net/room-fixture-${index}.mp3`, artwork: "", url: artist.url, duration: 210, rank: 1000000000 - index * 10000000, recordingKey: `adele:${title.toLowerCase()}` }));
  const pool = { artist, tracks, discoveryTracks: tracks, ranking: { kind: "streams", label: "Local room fixture ranking", sourceUrl: "https://example.invalid/local-fixture", asOf: "2026-11-12" }, coverage: { previewable: 30, ranked: 30, releaseCount: 4, loadedReleases: 4, status: "complete", hasMore: false }, fetchedAt: Date.now() };
  const cache = new MetadataCache(localPath(join(dirname(manifest.encore), "provider-cache.sqlite")));
  try {
    await cache.put(`live-v1:pool:${artist.id}`, pool, 3600000);
    await cache.put("live-v1:artists:genre-v2:adele", [artist], 3600000);
    await cache.put(`artist-portrait:v2:${artist.id}:adele`, null, 3600000);
    console.log(JSON.stringify({ artist }));
  } finally { await cache.close(); }
} else {
  const code = process.argv[3];
  if (!/^[A-Z0-9]{4,10}$/.test(code || "")) throw new Error("Expected room code.");
  const db = new DatabaseSync(manifest.encore);
  db.exec("PRAGMA busy_timeout=5000");
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT state FROM encore_rooms WHERE code=?").get(code);
    if (!row) throw new Error("Local room does not exist.");
    const room = JSON.parse(row.state);
    if (operation === "inspect") console.log(JSON.stringify(room));
    else {
      if (operation === "expire-reveal") room.revealUntil = Date.now() - 1;
      else if (operation === "expire-loading") room.loadingDeadline = Date.now() - 1;
      else if (operation === "expire-round") {
        room.startAt = Date.now() - 31000;
        room.roundEnd = Date.now() - 1;
        for (const member of room.members) if (member.guessAt !== null) member.guessAt = Date.now() - 16000;
      } else if (operation === "expire-room") room.expiresAt = Date.now() - 1;
      else if (operation === "provider-audio") {
        const releases = JSON.parse(readFileSync(join(root, "tempo-trap/data/catalog-releases.json"), "utf8"));
        const current = releases.releases.at(-1).version;
        if (!/^[a-f0-9]+$/.test(current)) throw new Error("Invalid catalog release.");
        const catalog = JSON.parse(readFileSync(join(root, `tempo-trap/data/catalog-releases/${current}.json`), "utf8"));
        const track = catalog.tracks.find(track => track.artist === "Adele" && track.previewUrl);
        if (!track) throw new Error("No real Adele preview in the committed catalog.");
        const pick = room.picks[room.round];
        pick.track.preview = track.previewUrl;
        pick.track.title = track.title;
        pick.track.url = track.appleMusicUrl;
        pick.track.artwork = track.artworkUrl;
        pick.choices.find(choice => choice.id === pick.correctChoiceId).label = track.title;
      }
      else if (operation === "play-now") {
        room.startAt = Date.now() - 1000;
        room.roundEnd = room.startAt + 30000;
      } else throw new Error("Unknown private fixture operation.");
      room.revision++;
      db.prepare("UPDATE encore_rooms SET state=?,expires_at=?,revision=? WHERE code=?").run(JSON.stringify(room), room.expiresAt, room.revision, code);
      console.log(JSON.stringify({ code, phase: room.phase, revision: room.revision }));
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}
