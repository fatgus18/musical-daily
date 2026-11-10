import type { Progress, Puzzle, SavedGame, Stats } from "./types";
import { previousDailyDate } from "./game.ts";
export const EMPTY_STATS: Stats = { played: 0, totalScore: 0, best: 0, streak: 0, longestStreak: 0, lastDate: null, history: [] };
export const storageKey = (puzzle: Puzzle, accountId?: string | null) => `${accountId ? `account:${accountId}:` : ""}${puzzle.mode === "daily" ? `tempo:daily:${puzzle.date}` : "tempo:practice"}`;
export function freshProgress(puzzle: Puzzle): Progress { return { round: 0, phase: "ready", guess: "", deadline: null, results: [], token: puzzle.token }; }
export function saveGame(puzzle: Puzzle, progress: Progress, accountId?: string | null) {
  try { localStorage.setItem(storageKey(puzzle, accountId), JSON.stringify({ puzzle, progress })); return true; } catch { return false; }
}
export function restoreGame(puzzle: Puzzle, accountId?: string | null): SavedGame | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(puzzle, accountId)) || "null") as SavedGame | null;
    if (!saved || saved.puzzle.version !== puzzle.version || saved.puzzle.date !== puzzle.date || saved.puzzle.mode !== puzzle.mode) return null;
    const p = saved.progress;
    if (!p || !Number.isInteger(p.round) || p.round < 0 || p.round > 4 || typeof p.token !== "string" || typeof p.guess !== "string" || !Array.isArray(p.results) || p.results.length > 5 ||
      !p.results.every(r => Number.isFinite(r.score) && r.score >= 0 && r.score <= 1000 && Number.isFinite(r.bpm)) ||
      !["ready", "loading", "listening", "guessing", "submitting", "reveal", "complete"].includes(p.phase) ||
      ((p.phase === "guessing" || p.phase === "submitting") && !Number.isFinite(p.deadline)) ||
      ((p.phase === "reveal" || p.phase === "complete") && p.results.length !== p.round + 1) ||
      (p.phase === "complete" && p.results.length !== 5) ||
      !Array.isArray(saved.puzzle.tracks) || saved.puzzle.tracks.length !== 5) return null;
    if (p.phase === "listening" || p.phase === "loading") p.phase = "ready";
    return saved;
  } catch { return null; }
}
export function readStats(): Stats {
  try { const saved = JSON.parse(localStorage.getItem("tempo:stats") || "null"); return saved && Array.isArray(saved.history) && Number.isFinite(saved.played) && Number.isFinite(saved.totalScore) ? { ...EMPTY_STATS, ...saved } : EMPTY_STATS; } catch { return EMPTY_STATS; }
}
export function recordDaily(date: string, score: number): Stats {
  const stats = readStats();
  if (stats.history.some(item => item.date === date)) return stats;
  const history = [...stats.history, { date, score }].sort((a, b) => a.date.localeCompare(b.date)).slice(-366);
  const lastDate = history.at(-1)!.date;
  const dates = new Set(history.map(item => item.date));
  let observedStreak = 0;
  for (let day = lastDate; dates.has(day); day = previousDailyDate(day)) observedStreak++;
  // An old tab can finish yesterday's signed mix after today's. Count it once
  // without moving lastDate backwards, and preserve streaks beyond history's cap.
  const priorStreak = stats.lastDate === previousDailyDate(date) ? stats.streak + 1 : stats.lastDate === lastDate ? stats.streak : 1;
  const streak = Math.max(observedStreak, priorStreak);
  const next = { played: stats.played + 1, totalScore: stats.totalScore + score, best: Math.max(stats.best, score), streak, longestStreak: Math.max(stats.longestStreak, streak), lastDate, history };
  try { localStorage.setItem("tempo:stats", JSON.stringify(next)); } catch { /* Local storage can be unavailable; gameplay still works. */ }
  return next;
}
