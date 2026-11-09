"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSound } from "./sound-client";

export interface PickerGame { id: string; name: string; description: string; href: string; icon: string; color: string; format: string }

export function GamePicker({ games, onLaunch }: { games: PickerGame[]; onLaunch: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const previous = useRef<string | null>(null);
  const [shown, setShown] = useState<PickerGame | null>(null);
  const [spinning, setSpinning] = useState(false);
  const heading = useId();
  const { unlock, play } = useSound();
  const stop = () => { if (interval.current) clearInterval(interval.current); interval.current = null; };
  useEffect(() => () => { if (interval.current) clearInterval(interval.current); }, []);
  const spin = () => {
    stop(); unlock();
    const pool = games.length > 1 ? games.filter(game => game.id !== previous.current) : games;
    const choice = pool[Math.floor(Math.random() * pool.length)];
    if (!choice) return;
    const finish = () => {
      stop(); setSpinning(false);
      if (!dialog.current?.open) return;
      previous.current = choice.id; setShown(choice); play("select");
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    setSpinning(true); setShown(games[0]); let frame = 0;
    interval.current = setInterval(() => {
      frame++;
      if (frame >= 9 || document.hidden || !dialog.current?.open) finish();
      else setShown(games[frame % games.length]);
    }, 95);
  };
  return <>
    <button type="button" className="hub-pick-trigger" onClick={() => { dialog.current?.showModal(); spin(); }}>Surprise me <span aria-hidden="true">↗</span></button>
    <dialog ref={dialog} className="game-picker-dialog" aria-labelledby={heading} onClose={() => { stop(); setSpinning(false); }} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <button className="picker-close" type="button" aria-label="Close game picker" onClick={() => dialog.current?.close()}>×</button>
      <span className="picker-eyebrow">LET YOUR NEXT OBSESSION FIND YOU</span>
      <h2 id={heading}>Your next spin<span>.</span></h2>
      <p className="picker-copy">{games.length < 4 ? "Picked from your current filter." : "Four games. Let a little chance choose."} Nothing starts until you’re ready.</p>
      <div className={`picker-record ${spinning ? "is-spinning" : ""}`} style={{ "--pick-color": shown?.color || "#c4f58a" } as React.CSSProperties} aria-hidden="true"><div><strong>{shown?.icon || "♫"}</strong><small>MUSICAL DAILY / SIDE YOU</small></div></div>
      <div className="picker-selection" aria-live="polite" aria-atomic="true"><span>{spinning ? "FINDING YOUR GROOVE…" : shown?.format}</span><h3 aria-hidden={spinning}>{shown?.name || "A fresh pick"}</h3><p>{spinning ? "A little suspense. A good record." : shown?.description}</p></div>
      <div className="picker-actions">{shown && !spinning ? <a href={shown.href} onClick={onLaunch} onAuxClick={event => { if (event.button === 1) onLaunch(); }}>Play {shown.name} <span aria-hidden="true">↗</span></a> : <button type="button" className="picker-wait" disabled>Choosing your game…</button>}<button type="button" onClick={spin} disabled={spinning}>Spin again <span aria-hidden="true">↻</span></button></div>
      <small className="picker-footnote">No repeat picks back to back. Just good choices.</small>
    </dialog>
  </>;
}
