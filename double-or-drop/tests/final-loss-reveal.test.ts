import test from "node:test";
import assert from "node:assert/strict";
import { FINAL_LOSS_REVEAL_MS, FinalLossCountdown, finalLossRevealKey } from "../src/lib/final-loss-reveal.ts";

const finalMiss = { id: "run-a", revision: 9, phase: "complete" as const, round: 4, lives: 0, endReason: "lives" as const, completionStatus: "completed" as const, reveal: { correct: false, round: 4 } };

test("only the third failed pick gets a final reveal; incomplete/cashout and stale reveals do not", () => {
  assert.equal(finalLossRevealKey(finalMiss), "run-a:9");
  assert.equal(finalLossRevealKey({ ...finalMiss, phase: "miss", lives: 1 }), null);
  assert.equal(finalLossRevealKey({ ...finalMiss, endReason: "cashout" }), null);
  assert.equal(finalLossRevealKey({ ...finalMiss, completionStatus: "incomplete" }), null);
  assert.equal(finalLossRevealKey({ ...finalMiss, reveal: { correct: true, round: 4 } }), null);
  assert.equal(finalLossRevealKey({ ...finalMiss, reveal: { correct: false, round: 3 } }), null);
  assert.equal(finalLossRevealKey({ ...finalMiss, reveal: undefined }), null);
  assert.equal(finalLossRevealKey(null), null);
});

test("results cannot replace the final pair before three visible seconds", () => {
  const countdown = new FinalLossCountdown();
  countdown.setVisible(true, 10_000);
  countdown.sample(12_999);
  assert.equal(countdown.complete, false);
  countdown.sample(13_000);
  assert.equal(countdown.complete, true);
  assert.equal(countdown.elapsedMs, FINAL_LOSS_REVEAL_MS);
});

test("going home or hiding the tab pauses the reveal rather than consuming the hold", () => {
  const countdown = new FinalLossCountdown();
  countdown.setVisible(true, 500);
  countdown.setVisible(false, 1_500);
  countdown.sample(90_000);
  assert.equal(countdown.elapsedMs, 1_000);
  assert.equal(countdown.complete, false);
  countdown.setVisible(true, 90_000);
  countdown.sample(91_999);
  assert.equal(countdown.complete, false);
  countdown.sample(92_000);
  assert.equal(countdown.complete, true);
});

test("reload resumes a partial reveal and does not repeat an already viewed reveal", () => {
  const first = new FinalLossCountdown();
  first.setVisible(true, 0);
  first.setVisible(false, 1_250);
  const resumed = new FinalLossCountdown(first.elapsedMs);
  resumed.setVisible(true, 100);
  resumed.sample(1_849);
  assert.equal(resumed.complete, false);
  resumed.sample(1_850);
  assert.equal(resumed.complete, true);
  assert.equal(new FinalLossCountdown(resumed.elapsedMs).complete, true);
});

test("bad checkpoints and timer ordering cannot produce negative or unbounded hold times", () => {
  for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(new FinalLossCountdown(elapsed).elapsedMs, 0);
  const countdown = new FinalLossCountdown(9_000);
  assert.equal(countdown.elapsedMs, FINAL_LOSS_REVEAL_MS);
  assert.equal(countdown.complete, true);
});
