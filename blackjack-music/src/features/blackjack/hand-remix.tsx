"use client";

import { useMemo, useState } from "react";
import { useSound } from "@/components/sound-client";
import type { PublicTrackCard } from "@/lib/puzzle";
import { nearestBestHand, remixTotal } from "@/lib/hand-remix";

const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);

export function HandRemix({ tracks, streams, target, original }: { tracks: PublicTrackCard[]; streams: Record<string, number>; target: number; original: string[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [solutionShown, setSolutionShown] = useState(false);
  const { play } = useSound();
  const records = useMemo(() => tracks.map(track => ({ ...track, streams: streams[track.id] })), [tracks, streams]);
  const best = useMemo(() => nearestBestHand(records, target, selected), [records, target, selected]);
  if (!best) return null;
  const total = remixTotal(records, selected), over = total > target;
  const perfect = total === target, atBest = total === best.total && selected.length > 0;
  const status = perfect ? "Perfect fit. That’s the sweet spot." : atBest ? "You found the best available hand." : over ? `${compact(total - target)} over. Try swapping a record.` : selected.length ? `${compact(target - total)} room left. Keep mixing.` : "Pick a few records. Find your way to the cap.";
  const change = (next: string[]) => {
    if (remixTotal(records, next) === target && total !== target) play("complete");
    setSelected(next); setHint(""); setSolutionShown(false);
  };
  const nudge = () => {
    const remove = selected.find(id => !best.ids.includes(id));
    const add = best.ids.find(id => !selected.includes(id));
    const id = remove || add;
    setHint(id ? `${remove ? "Try removing" : "Try adding"} “${tracks.find(track => track.id === id)?.title}”. You’re one step closer.` : "You’re already holding a best hand. Nicely done.");
  };
  return <details className="hand-remix">
    <summary><span className="remix-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.3A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.7"/></svg></span><span className="remix-summary-copy"><strong>The remix room</strong><small>Your score is saved. Can you build a better hand?</small></span><span className="remix-open"><span>Explore</span><b aria-hidden="true">+</b></span></summary>
    <div className="remix-body">
      <div className="remix-intro"><p>All the counts are out. Mix these nine tracks, ask for a nudge, and chase the best combination.</p><span>UNSCORED / PLAY AS MUCH AS YOU LIKE</span></div>
      <div className={`remix-console ${over ? "is-over" : atBest ? "is-perfect" : ""}`}>
        <div><small>YOUR REMIX</small><strong>{compact(total)}<span> / {compact(target)}</span></strong></div>
        <span className="remix-count">{selected.length} records selected <b aria-hidden="true">{atBest ? "✦" : "↗"}</b></span>
        <div className="remix-meter" role="meter" aria-label="Remix total toward target" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(target,total)} aria-valuetext={`${total.toLocaleString("en-US")} of ${target.toLocaleString("en-US")} streams${over ? ", over target" : ""}`}><i style={{ width: `${Math.min(100, total / target * 100)}%` }}/></div>
        <p role="status">{status}{solutionShown && " Best hand shown."}</p>
      </div>
      <fieldset className="remix-records"><legend>Choose records for your remix</legend>{records.map((record, index) => <button key={record.id} type="button" aria-pressed={selected.includes(record.id)} onClick={() => change(selected.includes(record.id) ? selected.filter(id => id !== record.id) : [...selected, record.id])}>
        <span className="remix-number" aria-hidden="true">{selected.includes(record.id) ? "✓" : String(index + 1).padStart(2,"0")}</span><span><strong>{record.title}</strong><small>{record.artist}</small></span><b title={`${record.streams.toLocaleString("en-US")} streams`}>{compact(record.streams)}</b>
      </button>)}</fieldset>
      <div className="remix-actions"><button type="button" onClick={nudge}>Give me a nudge <span aria-hidden="true">✧</span></button><button type="button" onClick={() => { setSelected(best.ids); setHint(""); setSolutionShown(true); }}>Show a best hand</button><button type="button" onClick={() => change(original)}>My original hand</button><button type="button" onClick={() => change([])} disabled={!selected.length}>Clear</button></div>
      {hint && <p className="remix-hint" role="status">{hint}</p>}
      <p className="remix-fine">This is a practice table. Your original result, streak and statistics stay as recorded.</p>
    </div>
  </details>;
}
