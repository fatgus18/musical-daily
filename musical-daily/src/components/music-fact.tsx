"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { drawMusicFact, FACT_HISTORY_KEY, readFactHistory, type MusicFact as Fact } from "@/lib/music-facts";

export function MusicFact() {
  const [fact, setFact] = useState<Fact | null>(null);
  const [hidden, setHidden] = useState(false);
  const history = useRef<string[]>([]);
  const initialized = useRef(false);
  const showButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const another = useCallback(() => {
    const next = drawMusicFact(history.current);
    history.current = next.history;
    try { localStorage.setItem(FACT_HISTORY_KEY, JSON.stringify(next.history)); } catch { /* Rotation still works for this visit. */ }
    setFact(next.fact);
  }, []);

  useEffect(() => {
    // Keep the first server render deterministic, and avoid consuming two facts
    // during React's development effect replay.
    const frame = requestAnimationFrame(() => {
      if (initialized.current) return;
      initialized.current = true;
      try { history.current = readFactHistory(localStorage.getItem(FACT_HISTORY_KEY)); } catch { /* Private mode: start a fresh rotation. */ }
      another();
    });
    return () => cancelAnimationFrame(frame);
  }, [another]);

  useEffect(() => {
    if (!returnFocus.current) return;
    returnFocus.current = false;
    (hidden ? showButton : hideButton).current?.focus({ preventScroll: true });
  }, [hidden]);

  if (hidden) return <div className="music-fact-hidden"><span aria-hidden="true">✳</span><span>Rabbit hole closed. For now.</span><button ref={showButton} type="button" onClick={() => { returnFocus.current = true; setHidden(false); }}>Show music fact <span aria-hidden="true">↗</span></button></div>;

  return <aside className="music-fact" aria-label="Off the record: a surprising music fact" aria-busy={!fact} data-fact-id={fact?.id}>
    <div className="music-fact-top"><span><b aria-hidden="true">✳</b> OFF THE RECORD <i /> <small>{fact?.kind || "MUSIC"}</small></span><button ref={hideButton} type="button" className="music-fact-hide" aria-label="Hide music fact for this visit" title="Hide for this visit" onClick={() => { returnFocus.current = true; setHidden(true); }}>Hide <span aria-hidden="true">×</span></button></div>
    <div className="music-fact-story" aria-live="polite" aria-atomic="true">
      {fact ? <><h2>{fact.headline}</h2><p>{fact.text}</p></> : <><h2>A little music rabbit hole.</h2><p className="music-fact-loading">Finding you a wonderfully strange story…</p></>}
    </div>
    <div className="music-fact-bottom">
      {fact && <a className="music-fact-destination" href={fact.musicUrl} title={fact.subject} target="_blank" rel="noopener noreferrer">{fact.musicLabel}<span aria-hidden="true">↗</span><span className="fact-sr-only"> (opens in a new tab)</span></a>}
      <div>{fact && <a className="music-fact-source" href={fact.sourceUrl} target="_blank" rel="noopener noreferrer" title={fact.sourceTitle} aria-label={`Fact source: ${fact.sourceTitle} (opens in a new tab)`}>Fact check <span aria-hidden="true">↗</span></a>}<button type="button" disabled={!fact} onClick={another} aria-label="Show another music fact"><span aria-hidden="true">↻</span> Another</button></div>
    </div>
  </aside>;
}
