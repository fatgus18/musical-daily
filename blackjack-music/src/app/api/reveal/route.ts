import { NextRequest, NextResponse } from "next/server";
import { generateDailyPuzzle, getTodayDateString } from "@/lib/puzzle";
import { persistHand, pickHand, readAccountHand, sameOrigin } from "@/lib/account-game";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const body = await request.json();
    const date = body.date || getTodayDateString();
    const seed = body.seed || undefined;
    const trackId = body.trackId;

    if (!seed) {
      let account;
      try { account = await readAccountHand(request, date); }
      catch { return NextResponse.json({ error: "Account sync is unavailable. Your hand is safe; retry this pick." }, { status: 503 }); }
      if (!account && body.accountRevision !== undefined) return NextResponse.json({ error: "Your sign-in session changed. Reload before continuing." }, { status: 409 });
      if (account) {
        if (!account.hand) return NextResponse.json({ error: "Reload your saved daily hand." }, { status: 409 });
        if (body.accountRevision !== account.revision) return NextResponse.json({ error: "This hand changed on another device. Reload to continue your saved hand." }, { status: 409 });
        const hand = pickHand(account.hand, trackId);
        try {
          const saved = await persistHand(request, hand, account.revision);
          if (saved.conflict) return NextResponse.json({ error: "This hand changed on another device. Reload to continue." }, { status: 409 });
          return NextResponse.json({ trackId, streams: hand.revealedStreams[trackId], accountRevision: saved.revision }, { headers: { "Cache-Control": "no-store" } });
        } catch { return NextResponse.json({ error: "Couldn't sync this pick. Reload your saved hand before trying again." }, { status: 503 }); }
      }
    }

    const puzzle = generateDailyPuzzle(date, seed, body.catalogVersion, body.rulesVersion);
    const track = puzzle.tracks.find((t) => t.id === trackId);

    if (!track) {
      return NextResponse.json(
        { error: "Track not found on this board" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      trackId: track.id,
      streams: track.streams,
    });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
