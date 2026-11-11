import { loadAccountProgress, saveProgress } from "@musical-daily/accounts/server";
import { evaluateRank, generateDailyPuzzle, type DailyPuzzleData, type RankTier, type RulesVersion } from "./puzzle";
export { sameOrigin } from "./request-origin";

export interface AccountHand {
  date: string; catalogVersion: string; rulesVersion: RulesVersion;
  pickedIds: string[]; burnedIds: string[]; revealedStreams: Record<string, number>;
  shieldAvailable: boolean; gameOver: boolean; finishData: FinishData | null;
}
export interface FinishData {
  rank: RankTier; finalSum: number; targetStreams: number;
  optimalHandIds: string[]; optimalSum: number; allStreams: Record<string, number>;
}
export function freshHand(puzzle: DailyPuzzleData): AccountHand {
  return { date: puzzle.date, catalogVersion: puzzle.catalogVersion, rulesVersion: puzzle.rulesVersion,
    pickedIds: [], burnedIds: [], revealedStreams: {}, shieldAvailable: true, gameOver: false, finishData: null };
}
export const accountHandKey = (date: string) => `daily:${date}`;
export function handPuzzle(hand: AccountHand) { return generateDailyPuzzle(hand.date, undefined, hand.catalogVersion, hand.rulesVersion); }
export function finishHand(puzzle: DailyPuzzleData, pickedIds: string[]): FinishData {
  const allStreams = Object.fromEntries(puzzle.tracks.map(track => [track.id, track.streams]));
  const finalSum = pickedIds.reduce((sum, id) => sum + allStreams[id], 0);
  return { rank: evaluateRank(finalSum, puzzle.targetStreams), finalSum, targetStreams: puzzle.targetStreams,
    optimalHandIds: puzzle.optimalHandIds, optimalSum: puzzle.optimalSum, allStreams };
}
export function pickHand(hand: AccountHand, trackId: string): AccountHand {
  const puzzle = handPuzzle(hand);
  const track = puzzle.tracks.find(track => track.id === trackId);
  if (!track || hand.gameOver || [...hand.pickedIds, ...hand.burnedIds].includes(trackId)) throw new Error("This track cannot be picked now.");
  const sum = hand.pickedIds.reduce((sum, id) => sum + hand.revealedStreams[id], 0);
  if (sum >= puzzle.targetStreams) throw new Error("Your hand is ready to finish.");
  const burns = sum + track.streams > puzzle.targetStreams && hand.shieldAvailable;
  const next: AccountHand = { ...hand, pickedIds: burns ? hand.pickedIds : [...hand.pickedIds, trackId],
    burnedIds: burns ? [...hand.burnedIds, trackId] : hand.burnedIds,
    revealedStreams: { ...hand.revealedStreams, [trackId]: track.streams }, shieldAvailable: burns ? false : hand.shieldAvailable };
  const nextSum = burns ? sum : sum + track.streams;
  if (nextSum >= puzzle.targetStreams || next.pickedIds.length + next.burnedIds.length === puzzle.tracks.length ||
    (puzzle.rulesVersion === "v2" && nextSum >= puzzle.targetStreams * 0.98)) {
    next.gameOver = true;
    next.finishData = finishHand(puzzle, next.pickedIds);
  }
  return next;
}
export async function readAccountHand(request: Request, date: string) {
  const { user, progress: stored } = await loadAccountProgress(request, "blackjack", accountHandKey(date));
  if (!user) return null;
  return { user, hand: stored?.value as AccountHand | undefined, revision: stored?.revision || 0 };
}
export async function persistHand(request: Request, hand: AccountHand, revision: number) {
  return saveProgress(request, "blackjack", accountHandKey(hand.date), hand, revision, handEvent(hand));
}
export function handEvent(hand: AccountHand) {
  if (!hand.gameOver || !hand.finishData) return;
  const result = hand.finishData;
  return { eventId: `daily:${hand.date}`, mode: "daily" as const, date: hand.date,
    score: result.rank === "BUST" ? 0 : result.finalSum / result.targetStreams * 100, maxScore: 100,
    won: result.rank !== "BUST", correct: result.rank === "BLACKJACK" ? 1 : 0, rounds: 1 };
}
