import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import releases from "../../data/catalog-releases.json";
import { selectTracks } from "./game";
import type { PublicTrack } from "./types";

interface CatalogTrack extends PublicTrack { bpm: number; bpmSource?: string; appleTrackId?: number }
interface Catalog { version: string; tracks: CatalogTrack[]; rotation?: string[][] }
const cache = new Map<string, Catalog>();
export function getCatalogVersion(date: string, practice = false): string {
  const matches = releases.releases.filter(r => practice || r.effectiveOn <= date);
  const release = matches.at(-1);
  if (!release) throw new Error("No catalog is published for this date.");
  return release.version;
}
export function hasCatalogVersion(version: string) { return releases.releases.some(r => r.version === version); }
function catalogFor(version: string): Catalog {
  if (!hasCatalogVersion(version)) throw new Error("This mix has expired.");
  let catalog = cache.get(version);
  if (!catalog) {
    catalog = JSON.parse(readFileSync(resolve(process.cwd(), "data/catalog-releases", `${version}.json`), "utf8")) as Catalog;
    cache.set(version, catalog);
  }
  return catalog;
}
export function getTracks(date: string, seed: string, version = getCatalogVersion(date, seed !== "daily")) {
  const catalog = catalogFor(version);
  let tracks: CatalogTrack[];
  if (seed === "daily" && catalog.rotation?.length) {
    const release = releases.releases.find(r => r.version === version)!;
    const day = Math.max(0, Math.floor((Date.parse(date) - Date.parse(release.effectiveOn)) / 86400000));
    const ids = catalog.rotation[day % catalog.rotation.length];
    const byId = new Map(catalog.tracks.map(t => [t.id,t]));
    tracks = ids.map(id => byId.get(id)!);
  } else { tracks = selectTracks(catalog.tracks, `${version}:${date}:${seed}`); }
  if (tracks.length !== 5 || tracks.some(t => !t)) throw new Error("The catalog needs five valid recordings.");
  return tracks;
}
export function publicTracks(date: string, seed: string, version?: string): PublicTrack[] {
  return getTracks(date, seed, version).map(t => ({ id:t.id,title:t.title,artist:t.artist,album:t.album,year:t.year,
    artworkUrl:t.artworkUrl,previewUrl:t.previewUrl,spotifyUrl:t.spotifyUrl,appleMusicUrl:t.appleMusicUrl,
    clipStartSeconds:t.clipStartSeconds,clipSeconds:t.clipSeconds }));
}
