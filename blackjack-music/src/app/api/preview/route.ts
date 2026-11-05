import { NextRequest, NextResponse } from "next/server";
import { generateDailyPuzzle, getTodayDateString, type RulesVersion } from "@/lib/puzzle";
import { resolveTrackPreview } from "@/lib/preview-media";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  let track;
  try {
    const board = generateDailyPuzzle(params.get("date") || getTodayDateString(), params.get("seed") || undefined, params.get("catalogVersion") || undefined, (params.get("rulesVersion") || undefined) as RulesVersion | undefined);
    track = board.tracks.find(item => item.id === params.get("trackId"));
    if (!track) throw new Error("Track is not on this board.");
  } catch {
    return NextResponse.json({ error: "This preview does not belong to the current board." }, { status: 400 });
  }
  const media = await resolveTrackPreview(track, params.get("repair") === "1");
  return NextResponse.json(media, { headers: { "Cache-Control": "no-store" } });
}
