import { NextRequest, NextResponse } from "next/server";
import {
  evaluateRank,
  generateDailyPuzzle,
  getTodayDateString,
} from "@/lib/puzzle";
import { finishHand, handPuzzle, persistHand, readAccountHand, sameOrigin } from "@/lib/account-game";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const body = await request.json();
    const date = body.date || getTodayDateString();
    const seed = body.seed || undefined;
    if (!Array.isArray(body.pickedIds) || body.pickedIds.length < 1 || body.pickedIds.length > 9 || body.pickedIds.some((id: unknown) => typeof id !== "string") || new Set(body.pickedIds).size !== body.pickedIds.length) {
      return NextResponse.json({ error: "Choose a hand of unique tracks from this board." }, { status: 400 });
    }
    const pickedIds: string[] = body.pickedIds;

    if (!seed) {
      let account;
      try { account = await readAccountHand(request, date); }
      catch { return NextResponse.json({ error: "Your account is temporarily unavailable. Retry to finish this hand." }, { status: 503 }); }
      if (!account && body.accountRevision !== undefined) return NextResponse.json({ error: "Your sign-in session changed. Reload before continuing." }, { status: 409 });
      if (account) {
        if (!account.hand) return NextResponse.json({ error: "Reload your account's daily hand." }, { status: 409 });
        let hand = account.hand;
        try {
          if (!hand.gameOver) {
            if (body.accountRevision !== account.revision || JSON.stringify(pickedIds) !== JSON.stringify(hand.pickedIds)) return NextResponse.json({ error: "This hand changed on another device. Reload to continue." }, { status: 409 });
            hand = { ...hand, gameOver: true, finishData: finishHand(handPuzzle(hand), hand.pickedIds) };
            const saved = await persistHand(request, hand, account.revision);
            if (saved.conflict) return NextResponse.json({ error: "This hand changed on another device. Reload to continue." }, { status: 409 });
          }
          // Completion and its statistics are committed atomically. A lost response
          // can safely be retried without replacing this first completed result.
          return NextResponse.json({ ...hand.finishData, accountState: hand }, { headers: { "Cache-Control": "no-store" } });
        } catch { return NextResponse.json({ error: "Your hand is saved. Account statistics will sync when you retry Stand or reload." }, { status: 503 }); }
      }
    }

    const puzzle = generateDailyPuzzle(date, seed, body.catalogVersion, body.rulesVersion);
    const allStreams: Record<string, number> = {};
    for (const t of puzzle.tracks) {
      allStreams[t.id] = t.streams;
    }
    if (pickedIds.some(id => !Object.hasOwn(allStreams, id))) return NextResponse.json({ error: "This hand contains a track outside the board." }, { status: 400 });

    const finalSum = pickedIds.reduce(
      (acc, id) => acc + (allStreams[id] || 0),
      0
    );

    const rank = evaluateRank(finalSum, puzzle.targetStreams);

    return NextResponse.json({
      rank,
      finalSum,
      targetStreams: puzzle.targetStreams,
      optimalHandIds: puzzle.optimalHandIds,
      optimalSum: puzzle.optimalSum,
      allStreams,
    });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
