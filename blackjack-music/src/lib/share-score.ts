import type { RankTier } from "./puzzle";

interface ShareScore {
  mode: "daily" | "practice";
  puzzleNumber: number;
  finalSum: number;
  targetStreams: number;
  rank: RankTier;
  picks: number;
  shieldAvailable: boolean;
  streak: number;
  origin: string;
  gamePath: string;
}

function formatStreams(streams: number): string {
  return streams >= 1_000_000_000
    ? `${(streams / 1_000_000_000).toFixed(2)}B`
    : `${Math.round(streams / 1_000_000)}M`;
}

/** Only aggregates enter the share: daily song positions and optimal picks stay private. */
export function buildShareScore(score: ShareScore): string {
  const title = score.mode === "daily"
    ? `Stream Blackjack — Day #${score.puzzleNumber}`
    : "Stream Blackjack (Practice)";
  // Start at the game entry, without a session, practice seed, or the current page's query string.
  const gameUrl = new URL(score.gamePath, new URL(score.origin).origin).href;
  const percent = ((score.finalSum / score.targetStreams) * 100).toFixed(1);

  return [
    `🎧 ${title}`,
    `🎯 ${formatStreams(score.finalSum)} / ${formatStreams(score.targetStreams)} (${percent}%) — ${score.rank}`,
    `🎵 Picks: ${score.picks} · 🛡️ Shield: ${score.shieldAvailable ? "unused" : "used"}`,
    ...(score.mode === "daily" ? [`🔥 Streak: ${score.streak}`] : []),
    "",
    score.mode === "daily" ? "Can you beat my score?" : "Try your own mix:",
    gameUrl,
  ].join("\n");
}
