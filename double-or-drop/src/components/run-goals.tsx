import type {PublicGame} from "@/lib/types";
import {BANK_TARGETS,goalProgress,type BankTarget} from "@/lib/run-goals";

const count = (value: number) => value.toLocaleString("en-US");
export function BankTargetPicker({value, onChange, disabled, best}: {value: BankTarget | null; onChange: (value: BankTarget | null) => void; disabled: boolean; best: number | null}) {
  return <div className="bank-target-setup"><div className="bank-target-copy"><span className="eyebrow">GIVE THIS RUN A REASON</span><h3>Pick a bank goal<span> ↗</span></h3><p>Optional. Only protected points count.</p></div><div className="bank-target-controls"><div className="bank-target-options" role="group" aria-label="Bank goal">{[null, ...BANK_TARGETS].map(target => <button key={target ?? "off"} disabled={disabled} aria-pressed={value === target} className={value === target ? "selected" : ""} onClick={() => onChange(target)}>{target ? count(target) : "Free play"}</button>)}</div><span className="personal-best-note">{best ? `✦ Personal best: ${count(best)} banked` : "✦ Your first saved bank sets your personal best."}</span></div></div>;
}
export function RunGoalRibbon({game, milestone}: {game: PublicGame; milestone: string | null}) {
  const goal = goalProgress(game), best = game.bestBankToBeat;
  const beatBest = Boolean(best && game.banked > best);
  if (!goal && !best && !milestone) return null;
  return <>{(goal || best) && <div className={`run-goal-ribbon ${goal?.reached ? "goal-reached" : ""}`}>
    {goal && <div className="run-goal-progress"><div><span>{goal.reached ? "✓ BANK GOAL MET" : "YOUR BANK GOAL"}</span><strong>{count(game.banked)} <small>/ {count(goal.target)}</small></strong></div><progress value={Math.min(game.banked, goal.target)} max={goal.target} aria-label={`Bank goal: ${count(game.banked)} of ${count(goal.target)} protected points`} /><small>{goal.reached ? "In the bank. Keep playing on your terms." : `${count(goal.remaining)} to go · unbanked points don’t count`}</small></div>}
    {best ? <div className={`record-chase ${beatBest ? "record-beaten" : ""}`}><span aria-hidden="true">✦</span><div><span>{beatBest ? "PERSONAL BEST BEATEN" : "YOUR BEST TO BEAT"}</span><strong>{count(best)} <small>banked</small></strong></div></div> : null}
  </div>}{milestone && <div key={`${game.id}:${milestone}`} className="run-milestone" role="status"><span aria-hidden="true">✳</span>{milestone}</div>}</>;
}
export function GoalOutcome({game}: {game: PublicGame}) {
  const goal = goalProgress(game);
  return goal ? <span className={`goal-outcome ${goal.reached ? "goal-reached" : ""}`}>{goal.reached ? `✓ ${count(goal.target)}-point bank goal reached` : `${count(game.banked)} of your ${count(goal.target)}-point bank goal protected`}</span> : null;
}
