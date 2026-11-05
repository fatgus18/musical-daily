export interface TrackRecord {
  id: string; // Official Spotify Track ID
  title: string;
  artist: string;
  releaseYear: number;
  streams: number;
  albumArtUrl?: string;
  previewUrl?: string;
  durationMs?: number;
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import releases from "../../data/catalog-releases.json";

const cache = new Map<string, TrackRecord[]>();
export function getCatalogVersion(date: string, practice = false): string {
  const release = releases.releases.filter(r => practice || r.effectiveOn <= date).at(-1);
  if (!release) throw new Error("No music catalog for this date.");
  return release.version;
}
export function getTrackPool(date: string, practice = false, version = getCatalogVersion(date,practice)): TrackRecord[] {
  if (!releases.releases.some(r => r.version === version)) throw new Error("Unknown catalog version.");
  let tracks = cache.get(version);
  if (!tracks) {
    const catalog = JSON.parse(readFileSync(resolve(process.cwd(), "data/catalog-releases", `${version}.json`), "utf8"));
    tracks = catalog.tracks as TrackRecord[];
    cache.set(version, tracks);
  }
  return tracks;
}

