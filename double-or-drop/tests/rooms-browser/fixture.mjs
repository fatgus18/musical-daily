// Private test process: never imported by an application or exposed as a route.
// Clock edits and metadata seeds are restricted to the disposable HTTPS fixture.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MetadataCache } from "../../../shared/music-provider/provider-cache.ts";

const root = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(join(root, "test-results-accounts/fixture.json"), "utf8"));
const directory = relative(tmpdir(), manifest.temporary);
if (manifest.localFixture !== true || manifest.origin !== "https://localhost:3100" || isAbsolute(directory) || directory.startsWith("..") || !directory.startsWith("musical-daily-services-smoke-")) throw new Error("Co-op QA requires the disposable local HTTPS fixture.");
function localPath(value) {
  const path = relative(manifest.temporary, value);
  if (!path || isAbsolute(path) || path.startsWith("..")) throw new Error("Co-op fixture path escaped its temporary directory.");
  return value;
}
localPath(manifest.doubleDrop);
const operation = process.argv[2];

if (operation === "catalog") {
  const artist = { id: "apple:262836961", name: "Adele", image: "", url: "https://music.apple.com/us/artist/adele/262836961" };
  const titles = ["Hello", "Rolling in the Deep", "Someone Like You", "Set Fire to the Rain", "Easy On Me", "Skyfall", "When We Were Young", "Send My Love (To Your New Lover)", "Water Under the Bridge", "Rumour Has It", "Chasing Pavements", "Make You Feel My Love"];
  const tracks = titles.map((title, index) => ({ id: `qa-coop-adele-${index}`, title, aliases: [], artistId: artist.id, artist: artist.name, preview: `https://cdnt-preview.dzcdn.net/coop-fixture-${index}.mp3`, artwork: "", url: artist.url, duration: 150 + index * 20, rank: 1000000000 - index * 50000000, recordingKey: `adele:${title.toLowerCase()}` }));
  const pool = { artist, tracks, discoveryTracks: tracks, ranking: { kind: "unranked", label: "Local metadata fixture", sourceUrl: artist.url, asOf: "2026-11-12" }, coverage: { previewable: tracks.length, ranked: 0, releaseCount: 4, loadedReleases: 4, status: "complete", hasMore: false }, fetchedAt: Date.now() };
  const cache = new MetadataCache(localPath(join(dirname(manifest.doubleDrop), "provider-cache.sqlite")));
  try {
    await cache.put(`live-v1:pool:${artist.id}`, pool, 3600000);
    await cache.put("live-v1:artists:genre-v2:adele", [artist], 3600000);
    await cache.put(`artist-portrait:v2:${artist.id}:adele`, null, 3600000);
    console.log(JSON.stringify({ artist }));
  } finally { await cache.close(); }
} else {
  const code = process.argv[3];
  if (!/^[A-Z0-9]{6}$/.test(code || "")) throw new Error("Expected room code.");
  const db = new DatabaseSync(manifest.doubleDrop);
  db.exec("PRAGMA busy_timeout=5000");
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT state FROM double_drop_rooms WHERE code=?").get(code);
    if (!row) throw new Error("Local co-op room does not exist.");
    const room = JSON.parse(row.state);
    if (operation === "inspect") console.log(JSON.stringify(room));
    else if (operation === "inspect-pin") console.log(JSON.stringify(db.prepare("SELECT room_code,version,expires_at FROM catalog_room_pins WHERE room_code=?").get(code)));
    else {
      if (operation === "expire-reveal") room.revealUntil = Date.now() - 1;
      else if (operation === "expire-pick") room.game.guessDeadline = Date.now() - 1;
      else if (operation === "expire-room") room.expiresAt = Date.now() - 1;
      else if (operation === "stale-all") for (const member of room.members) member.seenAt = Date.now() - 120000;
      else if (operation === "stale-active") room.members.find(member => member.id === room.activePlayerId).seenAt = Date.now() - 120000;
      else if (operation === "stale-host") room.members.find(member => member.id === room.hostId).seenAt = Date.now() - 120000;
      else throw new Error("Unknown private fixture operation.");
      room.revision++;
      db.prepare("UPDATE double_drop_rooms SET state=?,expires_at=?,revision=? WHERE code=?").run(JSON.stringify(room), room.expiresAt, room.revision, code);
      console.log(JSON.stringify({ code, phase: room.phase, revision: room.revision }));
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}
