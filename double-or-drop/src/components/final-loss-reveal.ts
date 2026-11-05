"use client";

import { useEffect, useRef, useState } from "react";
import { FinalLossCountdown, finalLossRevealKey } from "@/lib/final-loss-reveal";
import type { PublicGame } from "@/lib/types";

const STORAGE_KEY = "md:double-drop:final-loss-reveal";
interface Checkpoint { key: string; elapsed: number }

function readCheckpoint(key: string): number {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object" && "key" in saved && saved.key === key && "elapsed" in saved && typeof saved.elapsed === "number") return saved.elapsed;
  } catch { /* The reveal also works when browser storage is disabled. */ }
  return 0;
}

/**
 * Keep a terminal loss on the revealed pair for three visible seconds. Server
 * completion stays immediate, so delaying the presentation cannot duplicate
 * stats or make the player lose a result by navigating away.
 */
export function useFinalLossReveal(game: PublicGame | null, visible: boolean): boolean {
  const key = finalLossRevealKey(game);
  const checkpoint = useRef<Checkpoint | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    const saved = checkpoint.current?.key === key ? checkpoint.current.elapsed : readCheckpoint(key);
    const countdown = new FinalLossCountdown(saved);
    let interval: ReturnType<typeof setInterval> | undefined;

    const save = () => {
      checkpoint.current = { key, elapsed: countdown.elapsedMs };
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(checkpoint.current)); } catch { /* Keep the in-memory checkpoint. */ }
    };
    const tick = () => {
      countdown.sample(performance.now());
      save();
      if (countdown.complete) {
        clearInterval(interval);
        setFinishedKey(key);
      }
    };
    const visibility = () => {
      const isVisible = visible && document.visibilityState === "visible";
      countdown.setVisible(isVisible, performance.now());
      clearInterval(interval);
      interval = isVisible && !countdown.complete ? setInterval(tick, 100) : undefined;
      tick();
    };
    const pagehide = () => { clearInterval(interval); countdown.setVisible(false, performance.now()); save(); };

    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", visibility);
    return () => {
      clearInterval(interval);
      countdown.setVisible(false, performance.now());
      save();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", visibility);
    };
  }, [key, visible]);

  // A newly received final loss must render the pair immediately, before the
  // effect runs; otherwise a result screen would flash before the reveal.
  return key !== null && finishedKey !== key;
}
