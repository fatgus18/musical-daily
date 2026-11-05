import { NextRequest, NextResponse } from "next/server";
import { generateDailyPuzzle, getTodayDateString, type RulesVersion } from "@/lib/puzzle";
import { alternateSpotifyArtwork, knownTrackArtwork, resolveTrackArtwork } from "@/lib/artwork";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  let track;
  try {
    const board = generateDailyPuzzle(params.get("date") || getTodayDateString(), params.get("seed") || undefined, params.get("catalogVersion") || undefined, (params.get("rulesVersion") || undefined) as RulesVersion | undefined);
    track = board.tracks.find(item => item.id === params.get("trackId"));
    if (!track) throw new Error("Track is not on this board.");
  } catch {
    return NextResponse.json({ error: "This artwork does not belong to the current board." }, { status: 400 });
  }
  const failed = params.get("failedUrl");
  const known = knownTrackArtwork(track)?.url;
  const excluded = failed && known && (failed === known || failed === alternateSpotifyArtwork(known)) ? failed : undefined;
  const artwork = await resolveTrackArtwork(track, excluded);
  return NextResponse.json({ albumArtUrl: artwork?.url }, { headers: { "Cache-Control": "no-store" } });
}
