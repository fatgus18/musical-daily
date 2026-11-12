"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicRoom } from "@/lib/rooms/types";
import { withBasePath } from "@/lib/app-path";
import { useSound } from "./sound-client";

/** One decoded, immutable clip per round. Neither reconnecting nor hiding the tab restarts the clock. */
export function useRoomAudio(room: PublicRoom | null, serverTime: () => number, onLoaded: (identity:{matchId:string;round:number;audioRevision:number}) => Promise<unknown>) {
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const buffer = useRef<{key:string; value:AudioBuffer} | null>(null);
  const scheduled = useRef("");
  const committedGuess = useRef("");
  const loaded = useRef(onLoaded); loaded.current = onLoaded;
  const latestRoom = useRef(room); latestRoom.current = room;
  const time = useRef(serverTime); time.current = serverTime;
  const { setPreviewing } = useSound();
  const [status, setStatus] = useState<"locked"|"loading"|"ready"|"playing"|"error">("locked");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [decodedVersion, setDecodedVersion] = useState(0);
  const stop = useCallback(() => {
    if (source.current) { source.current.onended = null; try { source.current.stop(); } catch {} source.current.disconnect(); source.current = null; }
    scheduled.current = "";
    setPreviewing(false);
  }, [setPreviewing]);
  const unlock = useCallback(async () => {
    try {
      const Audio = window.AudioContext || (window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if (!Audio) throw new Error("This browser cannot play room audio. Try a current version of Safari, Chrome, Firefox or Edge.");
      if (!context.current || context.current.state === "closed") context.current = new Audio();
      await context.current.resume();
      if (context.current.state !== "running") throw new Error("Sound is paused by your browser. Tap Enable sound again.");
      setEnabled(true); setError(""); setStatus(buffer.current ? "ready" : "loading"); setRetry(value => value + 1);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sound could not start. Please retry."); setStatus("error"); return false; }
  }, []);
  const key = room ? `${room.matchId}:${room.round}:${room.audioRevision}` : "";
  const stopForGuess = useCallback(() => {
    // The POST may take longer than our scheduler tick. Committing locally
    // prevents old room state from restarting audio while that move travels.
    // A new round/match/audio revision naturally has a different key.
    committedGuess.current = key;
    stop();
    setStatus("ready");
  }, [key, stop]);
  const audioUrl = room?.audioUrl;
  const phase = room?.phase;
  useEffect(() => {
    stop();
    if (!enabled || !audioUrl || !["loading", "playing"].includes(phase || "")) return;
    const controller = new AbortController();
    let cancelled = false;
    const prepare = async () => {
      try {
        setError("");
        if (buffer.current?.key !== key) {
          setStatus("loading");
          const response = await fetch(withBasePath(audioUrl), {cache:"no-store", signal:AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])});
          if (!response.ok) throw new Error("This preview couldn't load. Retry audio; everyone waits for the same clip.");
          const bytes = await response.arrayBuffer();
          const engine = context.current;
          if (!engine) return;
          const decoded = await engine.decodeAudioData(bytes);
          if (cancelled) return;
          if (decoded.duration < 15) throw new Error("This preview is too short for a fair round. Ask the host to skip it for everyone.");
          buffer.current = {key, value:decoded};
          setDecodedVersion(value => value + 1);
        }
        if (cancelled) return;
        setStatus("ready");
        const current = latestRoom.current;
        if (current?.phase === "loading" && !current.you.loaded && `${current.matchId}:${current.round}:${current.audioRevision}` === key) await loaded.current({matchId:current.matchId,round:current.round,audioRevision:current.audioRevision});
      } catch (cause) {
        if (cancelled) return;
        setStatus("error"); setError(cause instanceof Error ? cause.message : "Audio could not load. Please retry.");
      }
    };
    void prepare();
    return () => { cancelled = true; controller.abort(); };
  }, [key, audioUrl, phase, enabled, retry, stop]);
  useEffect(() => {
    const sync = () => {
      const current = latestRoom.current;
      if (!current || current.phase !== "playing" || !current.startAt || current.you.guessAt || current.you.answered || committedGuess.current === key || document.hidden) { stop(); return; }
      const engine = context.current;
      const prepared = buffer.current;
      if (!engine || !prepared || prepared.key !== key) return;
      const elapsed = (time.current() - current.startAt) / 1000;
      if (elapsed >= current.clipSeconds) { stop(); setStatus("ready"); return; }
      if (engine.state !== "running") { stop(); setStatus("locked"); return; }
      if (scheduled.current === key) return;
      stop();
      const clipOffset = Math.max(0, Math.min(current.clipOffset, prepared.value.duration - current.clipSeconds));
      const alreadyPlayed = Math.max(0, elapsed);
      const node = engine.createBufferSource();
      node.buffer = prepared.value;
      node.connect(engine.destination);
      source.current = node;
      scheduled.current = key;
      node.onended = () => { if (source.current === node) { source.current = null; setStatus("ready"); setPreviewing(false); } };
      node.start(engine.currentTime + Math.max(0, -elapsed), clipOffset + alreadyPlayed, current.clipSeconds - alreadyPlayed);
      setPreviewing(true); setStatus("playing");
    };
    sync();
    const interval = window.setInterval(sync, 150);
    document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", sync); stop(); };
  }, [key, phase, room?.startAt, room?.you.guessAt, room?.you.answered, decodedVersion, enabled, retry, stop, setPreviewing]);
  useEffect(() => () => { stop(); void context.current?.close(); context.current = null; }, [stop]);
  return {status, error, enabled, unlock, stop, stopForGuess, retry:() => { setRetry(value => value + 1); }};
}
