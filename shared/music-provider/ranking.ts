import type { Track } from "./catalog.ts";
type RankedTier = "hit" | "favorite" | "deep";
const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
/** Provider-quality check shared with Encore's six/three/one difficulty distribution. */
export function tierPools(tracks: Track[]): [RankedTier, Track[], number][] {
  const ranked = [...new Map(tracks.filter(t => Number.isFinite(t.rank) && t.rank > 0).map(t => [normalize(t.title), t])).values()].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  if (ranked.length < 20 || new Set(ranked.map(t => t.rank)).size < 5) throw new Error("This artist needs at least 20 distinct, ranked songs with usable previews for a fair mix. Try another artist for now.");
  const topEnd = ranked.findIndex((t, i) => i >= Math.ceil(ranked.length * .4) && t.rank < ranked[i - 1].rank);
  const middleEnd = ranked.findIndex((t, i) => i >= Math.ceil(ranked.length * .75) && t.rank < ranked[i - 1].rank);
  if (topEnd < 6 || middleEnd - topEnd < 3 || ranked.length - middleEnd < 1) throw new Error("There isn't enough popularity separation to build all three levels for this artist yet.");
  return [["hit", ranked.slice(0, topEnd), 6], ["favorite", ranked.slice(topEnd, middleEnd), 3], ["deep", ranked.slice(middleEnd), 1]];
}
