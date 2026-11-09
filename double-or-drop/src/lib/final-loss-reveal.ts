import type { PublicGame } from "./types.ts";

export const FINAL_LOSS_REVEAL_MS = 3_000;

type FinalLossSnapshot = Pick<PublicGame, "id" | "revision" | "phase" | "round" | "lives" | "endReason" | "completionStatus"> & {
  reveal?: Pick<NonNullable<PublicGame["reveal"]>, "correct" | "round">;
};

/** Only a genuine third miss needs the final answer reveal, including a timeout. */
export function finalLossRevealKey(game: FinalLossSnapshot | null): string | null {
  if(game?.phase==="complete"&&game.endReason==="daily-complete"&&game.reveal?.round===game.round)return `${game.id}:${game.revision}`;
  return game?.phase === "complete" && game.endReason === "lives" && game.lives === 0
    && game.completionStatus !== "incomplete" && game.reveal?.correct === false
    && game.reveal.round === game.round ? `${game.id}:${game.revision}` : null;
}

/** Measures actual visible time, independently of the browser's wall clock. */
export class FinalLossCountdown {
  private elapsed: number;
  private since: number | null = null;

  constructor(savedElapsed = 0) {
    this.elapsed = Number.isFinite(savedElapsed) ? Math.max(0, Math.min(FINAL_LOSS_REVEAL_MS, savedElapsed)) : 0;
  }

  get elapsedMs(): number { return this.elapsed; }
  get complete(): boolean { return this.elapsed >= FINAL_LOSS_REVEAL_MS; }

  sample(now: number): void {
    if (this.since === null) return;
    this.elapsed = Math.min(FINAL_LOSS_REVEAL_MS, this.elapsed + Math.max(0, now - this.since));
    this.since = now;
  }

  setVisible(visible: boolean, now: number): void {
    this.sample(now);
    this.since = visible && !this.complete ? now : null;
  }
}
