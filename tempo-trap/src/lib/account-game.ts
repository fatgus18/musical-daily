import { loadAccountProgress, saveProgress } from "@musical-daily/accounts/server";
import { signSession, type Session } from "./session";
import type { Progress } from "./types";

export interface AccountMix { session: Session; deadline: number | null }
export const mixKey = (date: string) => `daily:${date}`;
export async function loadAccountMix(request: Request, date: string) {
  const { user, progress: snapshot } = await loadAccountProgress(request, "tempo", mixKey(date));
  if (!user) return null;
  return { user, mix: snapshot?.value as AccountMix | undefined, revision: snapshot?.revision || 0 };
}
export async function saveAccountMix(request: Request, mix: AccountMix, revision: number) {
  return saveProgress(request, "tempo", mixKey(mix.session.date), mix, revision, mixEvent(mix));
}
export function mixProgress(mix: AccountMix): Progress {
  const results = mix.session.results;
  return { round: Math.min(results.length, 4), phase: results.length === 5 ? "complete" : mix.deadline ? "guessing" : "ready",
    guess: "", deadline: mix.deadline, results, token: signSession(mix.session) };
}
export function mixEvent(mix: AccountMix) {
  const { session } = mix;
  if (session.mode !== "daily" || session.results.length !== 5) return;
  return { eventId: `daily:${session.date}`, date: session.date, mode: "daily" as const,
    score: session.results.reduce((sum, result) => sum + result.score, 0), maxScore: 5000,
    rounds: 5, correct: session.results.filter(result => result.score === 1000).length, won: true };
}
