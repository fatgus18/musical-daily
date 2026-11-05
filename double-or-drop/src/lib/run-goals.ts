import type {PublicGame} from "./types.ts";

export const BANK_TARGETS = [500, 1000, 3200] as const;
export type BankTarget = typeof BANK_TARGETS[number];
export function validBankTarget(value: unknown): value is BankTarget | null | undefined {
  return value === null || value === undefined || BANK_TARGETS.includes(value as BankTarget);
}
export function goalProgress(game: Pick<PublicGame, "banked" | "bankTarget">) {
  const target = game.bankTarget;
  return target ? {target, reached: game.banked >= target, remaining: Math.max(0, target - game.banked), percent: Math.min(100, Math.max(0, game.banked / target * 100))} : null;
}
/** Only live, forward state transitions create celebrations; loading a saved state does not. */
export function runMilestone(previous: PublicGame | null, next: PublicGame | null): string | null {
  if (!previous || !next || previous.id !== next.id || next.revision <= previous.revision) return null;
  const goal = goalProgress(next);
  if (goal && goal.reached && previous.banked < goal.target) return `Goal in the bank! ${goal.target.toLocaleString("en-US")} points protected.`;
  if (next.bestBankToBeat && next.banked > next.bestBankToBeat && previous.banked <= next.bestBankToBeat) return "A new personal best. That bank is all yours.";
  if (next.currentStreak > previous.currentStreak && [3, 6, 10, 15, 20].includes(next.currentStreak)) return `${next.currentStreak} correct in a row. You’re locked in.`;
  return null;
}
