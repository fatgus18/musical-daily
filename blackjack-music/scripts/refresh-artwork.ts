import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { knownTrackArtwork, resolveTrackArtwork, type TrackArtwork } from "../src/lib/artwork";
import type { TrackRecord } from "../src/lib/tracks";

async function main() {
  const releases = JSON.parse(readFileSync(resolve("data/catalog-releases.json"), "utf8")) as { releases: { version: string }[] };
  const tracks = new Map<string, TrackRecord>();
  for (const release of releases.releases) {
    const catalog = JSON.parse(readFileSync(resolve("data/catalog-releases", `${release.version}.json`), "utf8")) as { tracks: TrackRecord[] };
    for (const track of catalog.tracks) tracks.set(track.id, track);
  }
  const queue = [...tracks.values()];
  const current = JSON.parse(readFileSync(resolve("data/catalog-releases", `${releases.releases.at(-1)!.version}.json`), "utf8")) as { tracks: TrackRecord[] };
  const currentIds = new Set(current.tracks.map(track => track.id));
  const artwork: Record<string, TrackArtwork> = {};
  const missing: TrackRecord[] = [];
  let finished = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let track = queue.shift(); track; track = queue.shift()) {
      const needsLookup = !knownTrackArtwork(track);
      const hit = await resolveTrackArtwork(track);
      if (hit) artwork[track.id] = hit;
      else missing.push(track);
      finished += 1;
      if (finished % 100 === 0) console.log(`Resolved ${finished}/${tracks.size} artwork records`);
      if (needsLookup) await new Promise(done => setTimeout(done, 120));
    }
  }));
  mkdirSync(resolve("data"), { recursive: true });
  const output = resolve("data/artwork.json");
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), tracks: Object.fromEntries(Object.entries(artwork).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + "\n");
  renameSync(temporary, output);
  console.log(`${Object.keys(artwork).length}/${tracks.size} published recordings have artwork. Daily song IDs and answers are unchanged.`);
  console.log(`${current.tracks.filter(track => artwork[track.id]).length}/${current.tracks.length} current production recordings have artwork.`);
  if (missing.length) console.warn(missing.map(track => `${currentIds.has(track.id) ? "CURRENT" : "Legacy"}: ${track.id}: ${track.artist} — ${track.title}`).join("\n"));
  if (missing.length) process.exitCode = 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
