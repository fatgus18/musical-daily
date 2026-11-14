"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { dailyDate, isGuess, shouldRefreshDaily } from "@/lib/game";
import { EMPTY_STATS, freshProgress, readStats, recordDaily, restoreGame, saveGame } from "@/lib/storage";
import type { Mode, Progress, Puzzle, RoundResult, SavedGame, Stats } from "@/lib/types";
import type { GameStats } from "@musical-daily/accounts";
import { useSound } from "@/components/sound-client";
import { accountApiPath } from "@/components/account-client";
import { withBasePath } from "@/lib/app-path";

export function useTempo(accountId: string | null = null) {
  const { play: playSound } = useSound();
  const audibleRound = useRef<string | null>(null);
  const [game, setGame] = useState<SavedGame | null>(null);
  const gameRef = useRef<SavedGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [remaining, setRemaining] = useState(15);
  const [volume, setVolumeState] = useState(80);
  const [clockNow, setClockNow] = useState(Date.now);
  const clockSync = useRef({ server: Date.now(), local: Date.now() });
  const rolloverRequested = useRef<string | null>(null);
  const keepCompletedDaily = useRef<string | null>(null);
  const volumeRef = useRef(80);
  const context = useRef<AudioContext | null>(null);
  const gain = useRef<GainNode | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const statsRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const playbackStart = useRef(0);
  const audioData = useRef<{ url: string; promise: Promise<ArrayBuffer> } | null>(null);

  const commit = useCallback((puzzle: Puzzle, progress: Progress) => {
    const previous = gameRef.current;
    const serverNow = clockSync.current.server + Date.now() - clockSync.current.local;
    if (puzzle.mode === "daily" && progress.phase === "complete" &&
      previous?.puzzle.date === puzzle.date && previous.progress.phase !== "complete" &&
      puzzle.date !== dailyDate(new Date(serverNow))) {
      // A player finishing across midnight gets to keep, read and share the
      // result they just earned. Only a result already complete at rollover
      // should give way to the new mix automatically.
      keepCompletedDaily.current = puzzle.date;
    }
    const next = { puzzle, progress };
    gameRef.current = next; setGame(next);
    // Persist synchronously, including every input change and locked submission.
    if (!saveGame(puzzle, progress, accountId)) setStorageWarning(true);
  }, [accountId]);

  const refreshStats = useCallback(async () => {
    if (!accountId) { setStats(readStats()); return; }
    statsRequest.current?.abort();
    const controller = new AbortController(); statsRequest.current = controller;
    const current = generation.current;
    const active = () => mounted.current && generation.current === current && statsRequest.current === controller && !controller.signal.aborted;
    setStatsError(null);
    try {
      const response = await fetch(accountApiPath("/api/account/stats"), { cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error("Your statistics couldn't sync. Retry in a moment.");
      const payload = await response.json() as { user?: { id: string }; games: { tempo: GameStats } };
      if (!active()) return;
      if (payload.user?.id !== accountId) throw new Error("Your account changed. Refresh your account to see your statistics.");
      const saved = payload.games.tempo;
      const latestDailyDate = saved.recent.filter(result => result.mode === "daily").map(result => result.date).sort().at(-1) || null;
      setStats({ played: saved.played, totalScore: saved.totalScore, best: saved.bestScore, streak: saved.currentStreak,
        longestStreak: saved.bestStreak, lastDate: latestDailyDate,
        history: [...saved.recent].reverse().map(result => ({ date: result.date, score: result.score })) });
    } catch (cause) {
      if (active()) setStatsError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Your statistics took too long to load. Please retry.");
    } finally { if (statsRequest.current === controller) statsRequest.current = null; }
  }, [accountId]);

  const stop = useCallback(() => {
    if (source.current) { source.current.onended = null; try { source.current.stop(); } catch { /* Already stopped. */ } source.current.disconnect(); source.current = null; }
  }, []);

  const load = useCallback(async (mode: Mode = "daily", resume = true) => {
    generation.current++; const current = generation.current;
    audibleRound.current = null;
    stop(); request.current?.abort(); statsRequest.current?.abort(); busy.current = false;
    setLoading(true); setError(null); setElapsed(0); setRemaining(15);
    const controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch(withBasePath(`/api/daily?mode=${mode}`), { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error("Couldn’t load your mix. Please try again.");
      const puzzle: Puzzle = await response.json();
      if (!mounted.current || generation.current !== current) return;
      const receivedAt = Date.now();
      clockSync.current = { server: puzzle.serverNow ?? receivedAt, local: receivedAt };
      setClockNow(clockSync.current.server);
      let restored = resume ? restoreGame(puzzle, accountId) : null;
      if (accountId && mode === "daily") {
        if (!puzzle.accountProgress) throw new Error("Your account session changed. Reload to continue.");
        const canonical = puzzle.accountProgress;
        // Keep only an unsent local answer for this exact account and signed round.
        // The server's results and deadline always take precedence.
        const pending = restored?.progress;
        restored = { puzzle, progress: pending?.token === canonical.token && canonical.phase === "guessing"
          ? { ...canonical, guess: pending.guess, phase: pending.phase === "submitting" ? "submitting" : "guessing" }
          : canonical };
      }
      commit(restored?.puzzle || puzzle, restored?.progress || freshProgress(puzzle));
      setElapsed(restored && ["guessing", "submitting", "reveal", "complete"].includes(restored.progress.phase) ? 15 : 0);
      // Account history is secondary: a ready puzzle should be playable even
      // when the statistics service is slow or temporarily unavailable.
      void refreshStats();
    } catch (e) {
      if (mounted.current && current === generation.current && !controller.signal.aborted) setError(e instanceof Error && e.name !== "TimeoutError" ? e.message : "The mix took too long to load. Try again.");
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [commit, stop, accountId, refreshStats]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; generation.current++; request.current?.abort(); statsRequest.current?.abort(); stop(); void context.current?.close().catch(() => {}); context.current = null; };
  }, [load, stop]);

  // Keep open/background tabs aligned with the server's IST day. Clock sync is
  // separate from a restored puzzle, whose original date and signed token stay intact.
  useEffect(() => {
    const tick = () => setClockNow(clockSync.current.server + Date.now() - clockSync.current.local);
    const timer = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const today = dailyDate(new Date(clockNow));
  const newDailyAvailable = !!game && game.puzzle.mode === "daily" && game.puzzle.date !== today;
  useEffect(() => {
    if (!game || loading || !shouldRefreshDaily(game.puzzle, game.progress, today, keepCompletedDaily.current === game.puzzle.date) || rolloverRequested.current === today) return;
    // Only untouched/completed mixes refresh automatically. A playing round's
    // audio, deadline, signed results, and previous-date storage are never reset.
    rolloverRequested.current = today;
    void load("daily");
  }, [game, loading, today, load]);

  const track = game?.puzzle.tracks[game.progress.round];
  useEffect(() => {
    if (!track || loading) return;
    const controller = new AbortController();
    const promise = fetch(withBasePath(track.previewUrl), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }).then(response => {
      if (!response.ok) throw new Error("This preview is unavailable. Retry the clip in a moment.");
      return response.arrayBuffer();
    });
    promise.catch(() => {}); // Surface prefetch failures only when the player presses Play.
    audioData.current = { url: track.previewUrl, promise };
    return () => controller.abort();
  }, [track, loading]);

  const submit = useCallback(async (fromPlayer = true) => {
    const current = gameRef.current;
    if (!current || busy.current || !["guessing", "submitting"].includes(current.progress.phase)) return;
    busy.current = true;
    const requestGeneration = generation.current;
    const { puzzle, progress } = current;
    const guess = /^\d+$/.test(progress.guess) && isGuess(Number(progress.guess)) ? Number(progress.guess) : null;
    commit(puzzle, { ...progress, phase: "submitting" }); setError(null);
    try {
      const response = await fetch(withBasePath("/api/guess"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: progress.token, guess }), signal: AbortSignal.timeout(12000) });
      const answer = await response.json() as { result: RoundResult; results: RoundResult[]; token: string; error?: string };
      if (!response.ok) throw new Error(answer.error || "Couldn’t check your guess.");
      if (!mounted.current || generation.current !== requestGeneration) return;
      commit(puzzle, { ...progress, round: answer.results.length - 1, phase: "reveal", deadline: null, results: answer.results, token: answer.token });
      if (fromPlayer || audibleRound.current === progress.token) {
        audibleRound.current = null;
        playSound(answer.result.difference !== null && answer.result.difference <= 15 ? "correct" : "wrong");
      }
      if (puzzle.mode === "daily" && answer.results.length === 5) {
        if (accountId) void refreshStats();
        else setStats(recordDaily(puzzle.date, answer.results.reduce((n, r) => n + r.score, 0)));
      }
    } catch (e) {
      if (mounted.current && generation.current === requestGeneration) setError(`${e instanceof Error && e.name !== "TimeoutError" ? e.message : "Connection timed out."} Your answer is saved. Retry below.`);
    } finally { if (generation.current === requestGeneration) busy.current = false; }
  }, [commit, accountId, refreshStats, playSound]);

  const phase = game?.progress.phase;
  const deadline = game?.progress.deadline;
  useEffect(() => {
    if (phase !== "guessing" || !deadline) return;
    const tick = () => { const seconds = Math.max(0, (deadline - Date.now()) / 1000); setRemaining(seconds); if (seconds === 0) void submit(false); };
    tick(); const timer = setInterval(tick, 75);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [phase, deadline, submit]);

  useEffect(() => {
    if (phase !== "listening") return;
    const timer = setInterval(() => setElapsed(Math.min(15, Math.max(0, (context.current?.currentTime || 0) - playbackStart.current))), 75);
    return () => clearInterval(timer);
  }, [phase]);

  // A pending submission restored after refresh is retried with the exact same token and guess.
  useEffect(() => { if (phase === "submitting" && !error) void submit(false); }, [phase, error, submit]);

  const play = async () => {
    const current = gameRef.current;
    if (!current || current.progress.phase !== "ready") return;
    const requestGeneration = generation.current;
    const currentTrack = current.puzzle.tracks[current.progress.round];
    setError(null); setElapsed(0); commit(current.puzzle, { ...current.progress, phase: "loading" });
    try {
      // Resume directly inside the click gesture for Safari/iOS autoplay rules.
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio playback isn't supported in this browser. Open Tempo Trap in a current version of Safari, Chrome or Firefox.");
      context.current ||= new AudioContextClass();
      await context.current.resume();
      const ctx = context.current;
      gain.current ||= ctx.createGain(); gain.current.gain.value = volumeRef.current / 100;
      gain.current.disconnect(); gain.current.connect(ctx.destination);
      let bytes: ArrayBuffer;
      try {
        if (!audioData.current || audioData.current.url !== currentTrack.previewUrl) throw new Error("No prefetch");
        bytes = await audioData.current.promise;
      } catch {
        const response = await fetch(withBasePath(currentTrack.previewUrl), { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("The audio preview is currently unavailable.");
        bytes = await response.arrayBuffer();
        audioData.current = { url: currentTrack.previewUrl, promise: Promise.resolve(bytes) };
      }
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      if (!mounted.current || generation.current !== requestGeneration) return;
      if (buffer.duration < currentTrack.clipStartSeconds + 15) throw new Error("This preview is too short for a full round.");
      stop();
      const node = ctx.createBufferSource(); source.current = node; node.buffer = buffer; node.connect(gain.current!);
      playbackStart.current = ctx.currentTime;
      // Web Audio schedules the exact 15-second window, independent of timeupdate throttling.
      node.onended = async () => {
        if (!mounted.current || generation.current !== requestGeneration || gameRef.current?.progress.phase !== "listening") return;
        const active = gameRef.current;
        const delayedBy = Math.max(0, (ctx.currentTime - playbackStart.current - 15) * 1000);
        setElapsed(15); setRemaining(15);
        if (accountId && active.puzzle.mode === "daily") {
          commit(active.puzzle, { ...active.progress, phase: "loading" });
          try {
            const response = await fetch(withBasePath("/api/round"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: active.progress.token }), signal: AbortSignal.timeout(12000) });
            const answer = await response.json();
            if (!response.ok) throw new Error(answer.error || "Your guessing timer couldn't sync.");
            if (!mounted.current || generation.current !== requestGeneration) return;
            commit(active.puzzle, { ...active.progress, phase: "guessing", deadline: answer.deadline });
          } catch (cause) {
            if (!mounted.current || generation.current !== requestGeneration) return;
            setError(cause instanceof Error ? cause.message : "Your timer couldn't sync. Reload your saved mix.");
            commit(active.puzzle, { ...active.progress, phase: "ready" });
          }
        } else commit(active.puzzle, { ...active.progress, phase: "guessing", deadline: Date.now() + 15000 - delayedBy });
      };
      node.start(0, currentTrack.clipStartSeconds, 15);
      audibleRound.current = current.progress.token;
      commit(current.puzzle, { ...current.progress, phase: "listening" });
    } catch (e) {
      if (mounted.current && generation.current === requestGeneration) {
        setError(e instanceof Error ? `${e.message} Press play to retry.` : "Audio couldn’t play. Try again.");
        commit(current.puzzle, { ...current.progress, phase: "ready" });
      }
    }
  };

  const setGuess = (guess: string) => {
    const current = gameRef.current;
    if (!current || current.progress.phase !== "guessing" || Date.now() >= (current.progress.deadline || 0)) return;
    audibleRound.current = current.progress.token;
    commit(current.puzzle, { ...current.progress, guess });
  };
  const next = () => {
    const current = gameRef.current;
    if (!current || current.progress.phase !== "reveal") return;
    if (current.progress.round === 4) playSound("complete");
    setError(null); setElapsed(0); setRemaining(15);
    commit(current.puzzle, { ...current.progress, phase: current.progress.round === 4 ? "complete" : "ready", round: Math.min(4, current.progress.round + 1), guess: "", deadline: null });
  };
  const setVolume = (value: number) => { volumeRef.current = value; setVolumeState(value); if (gain.current) gain.current.gain.value = value / 100; };
  return { game, loading, error, stats, statsError, refreshStats, elapsed, remaining, volume, storageWarning, today, clockNow, newDailyAvailable, load, play, submit, setGuess, next, setVolume };
}
