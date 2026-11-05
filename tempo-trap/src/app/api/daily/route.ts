import { randomUUID } from "node:crypto";
import { getCatalogVersion, publicTracks } from "@/lib/catalog";
import { puzzleNumber, utcDate } from "@/lib/game";
import { signSession } from "@/lib/session";
import { loadAccountMix, mixProgress, saveAccountMix, type AccountMix } from "@/lib/account-game";

export async function GET(request: Request) {
  try {
    const mode = new URL(request.url).searchParams.get("mode") === "practice" ? "practice" : "daily";
    const seed = mode === "practice" ? randomUUID() : "daily";
    const date = utcDate();
    const version = getCatalogVersion(date, mode === "practice");
    if (mode === "daily") {
      const account = await loadAccountMix(request, date);
      if (account) {
        let mix = account.mix;
        let revision = account.revision;
        if (!mix) {
          mix = { session: { version, date, seed, mode, results: [], expires: Date.now() + 172800000, accountId: account.user.id }, deadline: null };
          const saved = await saveAccountMix(request, mix, 0);
          if (saved.conflict) mix = saved.value as AccountMix;
          revision = saved.revision;
        }
        const active = mix.session;
        return Response.json({ date, number: puzzleNumber(date), mode, seed: active.seed, version: active.version,
          tracks: publicTracks(date, active.seed, active.version), token: signSession(active),
          accountProgress: mixProgress(mix), accountRevision: revision }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    const token = signSession({ version, date, seed, mode, results: [], expires: Date.now() + 172800000 });
    return Response.json({ date, number: puzzleNumber(date), mode, seed, version, tracks: publicTracks(date, seed, version), token }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Daily puzzle unavailable:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Today’s mix isn’t ready. Please try again shortly." }, { status: 503 });
  }
}
