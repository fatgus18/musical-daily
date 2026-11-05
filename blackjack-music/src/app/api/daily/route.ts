import { NextRequest, NextResponse } from "next/server";
import {
  generateDailyPuzzle,
  getTodayDateString,
  PublicTrackCard,
  type RulesVersion,
} from "@/lib/puzzle";
import { boardTrackMedia } from "@/lib/preview-media";
import { freshHand, handPuzzle, persistHand, readAccountHand, type AccountHand } from "@/lib/account-game";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || getTodayDateString();
  const seed = searchParams.get("seed") || undefined;

  let puzzle;
  let accountState: AccountHand | undefined;
  let accountRevision: number | undefined;
  try {
    puzzle = generateDailyPuzzle(date, seed, searchParams.get("catalogVersion") || undefined, (searchParams.get("rulesVersion") || undefined) as RulesVersion | undefined);
  } catch {
    return NextResponse.json({ error: "This board could not be loaded. Check the date and saved game version." }, { status: 400 });
  }

  if (!seed) {
    try {
      const account = await readAccountHand(request, date);
      if (account) {
        if (!account.hand) {
          // A signed-in board is always issued by the server's current daily rules.
          if (date !== new Date().toISOString().slice(0, 10)) return NextResponse.json({ error: "Choose today's UTC daily board." }, { status: 400 });
          const hand = freshHand(generateDailyPuzzle(date));
          const saved = await persistHand(request, hand, 0);
          accountState = saved.conflict ? saved.value as AccountHand : hand;
          accountRevision = saved.revision;
        } else {
          accountState = account.hand;
          accountRevision = account.revision;
        }
        puzzle = handPuzzle(accountState);
      }
    } catch {
      return NextResponse.json({ error: "Your account progress is temporarily unavailable. Retry to keep your saved hand safe." }, { status: 503 });
    }
  }

  const enrichedTracks: PublicTrackCard[] = await Promise.all(
    puzzle.tracks.map(async (t) => {
      const media = await boardTrackMedia(t);
      return {
        id: t.id,
        title: t.title,
        artist: t.artist,
        releaseYear: t.releaseYear,
        albumArtUrl: media.albumArtUrl,
        previewUrl: media.previewUrl,
        previewSourceUrl: media.previewSourceUrl,
        previewStatus: media.previewStatus,
      };
    })
  );

  return NextResponse.json({
    rulesVersion: puzzle.rulesVersion,
    catalogVersion: puzzle.catalogVersion,
    date: puzzle.date,
    seedKey: puzzle.seedKey,
    puzzleNumber: puzzle.puzzleNumber,
    targetStreams: puzzle.targetStreams,
    tracks: enrichedTracks,
    accountState,
    accountRevision,
  }, { headers: { "Cache-Control": "no-store" } });
}
