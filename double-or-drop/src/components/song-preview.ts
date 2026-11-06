"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/app-path";
import { useSound } from "./sound-client";
import type { PublicTrack } from "@/lib/types";

export function useSongPreview(scope: string, allowed: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setPreviewing } = useSound();
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const stop = useCallback(() => {
    attempt.current++;
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    const player = audio.current;
    if (player) { player.onended = null; player.onerror = null; player.pause(); player.removeAttribute("src"); player.load(); }
    setPlaying(null); setLoading(null); setPreviewing(false);
  }, [setPreviewing]);
  useEffect(() => { stop(); return stop; }, [scope, allowed, stop]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") stop(); };
    document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide);
  }, [stop]);
  async function play(track: PublicTrack) {
    if (!allowed || !track.previewUrl || !audio.current) return;
    const toggling = playing === track.id || loading === track.id;
    stop(); setError(null); if (toggling) return;
    const token = attempt.current, player = audio.current;
    setLoading(track.id); setPreviewing(true);
    const fail = () => {
      if (attempt.current !== token) return;
      stop(); setError({ id: track.id, message: "Preview couldn’t play. Tap to retry." });
    };
    player.volume = 0.7; player.src = withBasePath(track.previewUrl); player.onended = stop; player.onerror = fail;
    timer.current = setTimeout(fail, 8000);
    try {
      await player.play();
      if (attempt.current !== token) return;
      if (timer.current) clearTimeout(timer.current);
      setLoading(null); setPlaying(track.id);
      timer.current = setTimeout(stop, 10000);
    } catch { fail(); }
  }
  return { audio, playing, loading, error, play, stop };
}
