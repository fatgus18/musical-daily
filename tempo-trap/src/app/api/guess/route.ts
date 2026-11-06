import { getTracks } from "@/lib/catalog";
import { isGuess, scoreGuess } from "@/lib/game";
import { readSession, signSession } from "@/lib/session";
import { loadAccountMix, saveAccountMix } from "@/lib/account-game";
import { sameOrigin } from "@/lib/request-origin";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const { token, guess } = await request.json();
    if (guess !== null && !isGuess(guess)) return Response.json({ error: "Enter a whole-number BPM between 40 and 220." }, { status: 400 });
    const session = readSession(token);
    if (session.mode === "daily") {
      let account;
      try { account = await loadAccountMix(request, session.date); }
      catch { return Response.json({ error: "Your account couldn't sync. Retry your saved answer." }, { status: 503 }); }
      if (session.accountId && (!account || account.user.id !== session.accountId)) return Response.json({ error: "This mix belongs to a different player. Reload to continue." }, { status: 409 });
      if (account) {
        if (session.accountId !== account.user.id || !account.mix) return Response.json({ error: "Start your account's daily mix before answering." }, { status: 409 });
        let mix = account.mix;
        const round = session.results.length;
        if (round >= 5) return Response.json({ error: "This mix is already complete." }, { status: 409 });
        try {
          if (round === mix.session.results.length) {
            if (!mix.deadline) return Response.json({ error: "Listen to this round before guessing." }, { status: 409 });
            const track = getTracks(mix.session.date, mix.session.seed, mix.session.version)[round];
            // A small transport allowance lets a guess sent at zero arrive on time.
            const acceptedGuess = Date.now() <= mix.deadline + 2000 ? guess : null;
            const result = { round, trackId: track.id, guess: acceptedGuess, bpm: track.bpm, ...scoreGuess(acceptedGuess, track.bpm) };
            mix = { session: { ...mix.session, results: [...mix.session.results, result] }, deadline: null };
            const saved = await saveAccountMix(request, mix, account.revision);
            if (saved.conflict) return Response.json({ error: "An answer was saved on another device. Reload to continue that mix." }, { status: 409 });
          } else if (round > mix.session.results.length) return Response.json({ error: "Reload your account's saved mix." }, { status: 409 });
          // A repeated final request returns its original canonical result.
          return Response.json({ result: mix.session.results[round], results: mix.session.results, token: signSession(mix.session) }, { headers: { "Cache-Control": "no-store" } });
        } catch { return Response.json({ error: "Your answer is saved. Retry to finish syncing your account." }, { status: 503 }); }
      }
    }
    const round = session.results.length;
    if (round >= 5) return Response.json({ error: "This mix is already complete." }, { status: 409 });
    const track = getTracks(session.date, session.seed, session.version)[round];
    const result = { round, trackId: track.id, guess, bpm: track.bpm, ...scoreGuess(guess, track.bpm) };
    const results = [...session.results, result];
    return Response.json({ result, results, token: signSession({ ...session, results }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error && /session|expired|mix/.test(error.message) ? error.message : "Couldn’t read this guess." }, { status: 400 });
  }
}
