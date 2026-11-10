"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { TrackArtwork } from "./track-artwork";
import { BlackjackEmblem, BlackjackStage } from "./blackjack-stage";
import { HandRemix } from "./hand-remix";
import { MusicalDailyBrand } from "@/components/musical-daily-brand";
import { AccountButton, useAccount } from "@/components/account-client";
import { useSound } from "@/components/sound-client";
import { withBasePath } from "@/lib/app-path";
import type { GameStats } from "@musical-daily/accounts";
import type { PublicTrackCard, RankTier, RulesVersion } from "@/lib/puzzle";

interface DailyApiResponse {
  rulesVersion: RulesVersion;
  catalogVersion: string;
  date: string;
  seedKey: string;
  puzzleNumber: number;
  targetStreams: number;
  tracks: PublicTrackCard[];
  accountState?: SavedDailyState;
  accountRevision?: number;
}

interface FinishData {
  rank: RankTier;
  finalSum: number;
  targetStreams: number;
  optimalHandIds: string[];
  optimalSum: number;
  allStreams: Record<string, number>;
}

interface PlayerStats {
  played: number;
  currentStreak: number;
  maxStreak: number;
  lastCompletedDate: string | null;
  blackjacks: number;
  tierCounts: Record<RankTier, number>;
}

interface SavedDailyState {
  catalogVersion?: string;
  rulesVersion?: RulesVersion;
  date: string;
  pickedIds: string[];
  burnedIds: string[];
  revealedStreams: Record<string, number>;
  shieldAvailable: boolean;
  gameOver: boolean;
  finishData: FinishData | null;
}

const DEFAULT_STATS: PlayerStats = {
  played: 0,
  currentStreak: 0,
  maxStreak: 0,
  lastCompletedDate: null,
  blackjacks: 0,
  tierCounts: {
    BLACKJACK: 0,
    "GOLD RECORD": 0,
    CHARTING: 0,
    SOUNDCHECK: 0,
    BUST: 0,
  },
};

function formatStreams(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(2)}B`;
  }
  return `${Math.round(n / 1_000_000)}M`;
}

function getLocalDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getYesterdayDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export default function StreamBlackjackPage({ hubUrl }: { hubUrl: string }) {
  const account = useAccount();
  if (account.loading || account.error) return <><header className="mx-auto flex max-w-5xl items-center justify-between p-4"><MusicalDailyBrand href={hubUrl} showBack /><AccountButton statsHref="/stats" /></header><p className="p-8 text-center" role="status">{account.error || "Finding your listening profile…"}</p>{account.error && <button className="mx-auto block" onClick={() => void account.refresh()}>Retry account connection</button>}</>;
  return <BlackjackGame key={account.user?.id || "guest"} hubUrl={hubUrl} accountId={account.user?.id || null} />;
}

function BlackjackGame({ hubUrl, accountId }: { hubUrl: string; accountId: string | null }) {
  const { play: playSound } = useSound();
  const soundActive = useRef(true);
  useEffect(() => { soundActive.current = true; return () => { soundActive.current = false; }; }, []);
  const playDate = useCallback(() => accountId ? new Date().toISOString().slice(0, 10) : getLocalDateStr(), [accountId]);
  const storagePrefix = accountId ? `account:${accountId}:` : "";
  const accountRevision = useRef<number | undefined>(undefined);
  const [board, setBoard] = useState<DailyApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [practiceSeed, setPracticeSeed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const requestInFlight = useRef(false);
  const boardRequest = useRef(0);

  // Gameplay state
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [burnedIds, setBurnedIds] = useState<string[]>([]);
  const [revealedStreams, setRevealedStreams] = useState<Record<string, number>>({});
  const [shieldAvailable, setShieldAvailable] = useState(true);
  const [shieldToast, setShieldToast] = useState<string | null>(null);
  const [busyTrackId, setBusyTrackId] = useState<string | null>(null);
  const [gameOver, setGameOver] = useState(false);
  const [finishData, setFinishData] = useState<FinishData | null>(null);

  // Animated odometer display value
  const [displaySum, setDisplaySum] = useState(0);
  const displaySumRef = useRef(0);

  // Audio preview player
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loadingPreviewId, setLoadingPreviewId] = useState<string | null>(null);
  const [previewMessages, setPreviewMessages] = useState<Record<string, string>>({});
  const previewRequest = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Modals & UI
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [countdown, setCountdown] = useState("00:00:00");
  const [stats, setStats] = useState<PlayerStats>(DEFAULT_STATS);

  const currentSum = pickedIds.reduce(
    (sum, id) => sum + (revealedStreams[id] || 0),
    0
  );

  // Smooth odometer animation whenever currentSum changes
  useEffect(() => {
    let frame: number;
    const start = displaySumRef.current;
    const diff = currentSum - start;
    if (diff === 0) return;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450;
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = duration === 0 ? 1 : Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      const nextDisplaySum = Math.round(start + diff * eased);
      displaySumRef.current = nextDisplaySum;
      setDisplaySum(nextDisplaySum);
      if (elapsed < 1) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [currentSum]);

  const refreshStats = useCallback(async () => {
    if (!accountId) return;
    const response = await fetch(withBasePath("/api/account/stats"), { cache: "no-store" });
    if (!response.ok) throw new Error("Your statistics couldn't sync. Retry in a moment.");
    const payload = await response.json() as { games: { blackjack: GameStats } };
    const saved = payload.games.blackjack;
    setStats({ ...DEFAULT_STATS, played: saved.played, currentStreak: saved.currentStreak, maxStreak: saved.bestStreak,
      lastCompletedDate: saved.lastPlayed, blackjacks: saved.totalCorrect });
  }, [accountId]);

  // Guest history remains on this browser; an account reads its server history.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (accountId) { void refreshStats().catch(cause => setError(cause.message)); return; }
      try {
        const raw = localStorage.getItem("sbj_stats_v2");
        if (raw) setStats({ ...DEFAULT_STATS, ...JSON.parse(raw) });
      } catch {
        // Ignore storage errors
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [accountId, refreshStats]);

  const stopAudio = useCallback(() => {
    previewRequest.current += 1;
    previewAbort.current?.abort();
    previewAbort.current = null;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }
    setPlayingTrackId(null);
    setLoadingPreviewId(null);
  }, []);

  useEffect(() => () => {
    previewRequest.current += 1;
    previewAbort.current?.abort();
    audioRef.current?.pause();
    if (previewTimer.current) clearTimeout(previewTimer.current);
  }, []);

  const toggleAudioPreview = async (e: React.MouseEvent, track: PublicTrackCard) => {
    e.stopPropagation();
    if (playingTrackId === track.id || loadingPreviewId === track.id) {
      stopAudio();
      return;
    }

    stopAudio();
    const attempt = previewRequest.current;
    const controller = new AbortController();
    previewAbort.current = controller;
    setLoadingPreviewId(track.id);
    setPreviewMessages(previous => ({ ...previous, [track.id]: "" }));
    const current = () => attempt === previewRequest.current && !controller.signal.aborted;

    const lookup = async (repair: boolean) => {
      const params = new URLSearchParams({
        date: board!.date, trackId: track.id, catalogVersion: board!.catalogVersion, rulesVersion: board!.rulesVersion,
      });
      if (practiceSeed) params.set("seed", practiceSeed);
      if (repair) params.set("repair", "1");
      const response = await fetch(withBasePath(`/api/preview?${params}`), { signal: controller.signal });
      if (!response.ok) throw new Error("Preview lookup failed.");
      const media = await response.json() as Pick<PublicTrackCard, "previewUrl" | "albumArtUrl" | "previewStatus" | "previewSourceUrl">;
      if (!current()) return;
      setBoard(previous => previous && ({ ...previous, tracks: previous.tracks.map(item => item.id === track.id ? { ...item, ...media, previewUrl: media.previewUrl, previewSourceUrl: media.previewSourceUrl, albumArtUrl: media.albumArtUrl || item.albumArtUrl } : item) }));
      if (!media.previewUrl) {
        setLoadingPreviewId(null);
        setPreviewMessages(previous => ({ ...previous, [track.id]: media.previewStatus === "retry" ? "Preview service is busy. Tap to retry." : "No matching preview available. Tap to retry later." }));
      }
      return media.previewUrl;
    };

    const play = async (url: string, repaired: boolean) => {
      if (!current()) return;
      const audio = new Audio(withBasePath(url));
      audio.volume = 0.5;
      audioRef.current = audio;
      let failed = false;
      const failedPlayback = async () => {
        if (!current() || failed) return;
        failed = true;
        audio.pause();
        if (previewTimer.current) clearTimeout(previewTimer.current);
        setPlayingTrackId(null);
        setLoadingPreviewId(track.id);
        try {
          const replacement = !repaired ? await lookup(true) : undefined;
          if (replacement && replacement !== url) return void await play(replacement, true);
          if (current()) {
            setLoadingPreviewId(null);
            setPreviewMessages(previous => ({ ...previous, [track.id]: "Preview couldn't play. Tap to retry." }));
          }
        } catch {
          if (current()) {
            setLoadingPreviewId(null);
            setPreviewMessages(previous => ({ ...previous, [track.id]: "Couldn't load preview. Tap to retry." }));
          }
        }
      };
      audio.onerror = () => { void failedPlayback(); };
      audio.onloadedmetadata = () => { if (audio.duration > 0 && audio.duration < 29) void failedPlayback(); };
      audio.ontimeupdate = () => { if (current() && audio.currentTime >= 30) stopAudio(); };
      audio.onended = () => { if (current()) stopAudio(); };
      previewTimer.current = setTimeout(() => { void failedPlayback(); }, 12_000);
      try {
        await audio.play();
        if (!current() || failed) { audio.pause(); return; }
        setLoadingPreviewId(null);
        setPlayingTrackId(track.id);
        if (previewTimer.current) clearTimeout(previewTimer.current);
        previewTimer.current = setTimeout(() => { if (current()) stopAudio(); }, 30_000);
      } catch (reason) {
        if (!current()) return;
        if (reason instanceof DOMException && reason.name === "NotAllowedError") {
          if (previewTimer.current) clearTimeout(previewTimer.current);
          setLoadingPreviewId(null);
          setPreviewMessages(previous => ({ ...previous, [track.id]: "Preview ready. Tap again to play." }));
        } else await failedPlayback();
      }
    };
    try {
      const url = track.previewUrl || await lookup(Boolean(previewMessages[track.id]) || track.previewStatus === "unavailable" || track.previewStatus === "retry");
      if (url) await play(url, false);
    } catch {
      if (current()) {
        setLoadingPreviewId(null);
        setPreviewMessages(previous => ({ ...previous, [track.id]: "Couldn't load preview. Tap to retry." }));
      }
    }
  };

  const saveDailyProgress = (
    dateStr: string,
    nextState: Omit<SavedDailyState, "date">
  ) => {
    try {
      const payload: SavedDailyState = { date: dateStr, catalogVersion: board?.catalogVersion, rulesVersion: board?.rulesVersion, ...nextState };
      localStorage.setItem(`${storagePrefix}sbj_daily_${dateStr}`, JSON.stringify(payload));
    } catch {
      // Ignore
    }
  };

  const recordCompletedDailyStats = (dateStr: string, rank: RankTier) => {
    if (accountId) { void refreshStats().catch(cause => setError(cause.message)); return; }
    setStats((prev) => {
      if (prev.lastCompletedDate === dateStr) return prev;

      const isWin = rank !== "BUST";
      const wasYesterday =
        prev.lastCompletedDate === getYesterdayDateStr(dateStr);
      const nextStreak = isWin
        ? wasYesterday || prev.currentStreak === 0
          ? prev.currentStreak + 1
          : 1
        : 0;

      const updated: PlayerStats = {
        played: prev.played + 1,
        currentStreak: nextStreak,
        maxStreak: Math.max(prev.maxStreak, nextStreak),
        lastCompletedDate: dateStr,
        blackjacks: prev.blackjacks + (rank === "BLACKJACK" ? 1 : 0),
        tierCounts: {
          ...prev.tierCounts,
          [rank]: (prev.tierCounts[rank] || 0) + 1,
        },
      };

      try {
        localStorage.setItem("sbj_stats_v2", JSON.stringify(updated));
      } catch {
        // Ignore
      }
      return updated;
    });
  };

  const loadBoard = useCallback(
    async (dateStr: string, customSeed: string | null) => {
      const requestId = ++boardRequest.current;
      stopAudio();
      setLoading(true);
      setShieldToast(null);
      setError(null);
      try {
        const params = new URLSearchParams({ date: dateStr });
        if (customSeed) params.set("seed", customSeed);
        let saved: SavedDailyState | null = null;
        if (!customSeed && !accountId) {
          try {
            const raw = localStorage.getItem(`sbj_daily_${dateStr}`);
            if (raw) {
              const parsed = JSON.parse(raw) as SavedDailyState;
              if (parsed.date === dateStr && Array.isArray(parsed.pickedIds) && Array.isArray(parsed.burnedIds) && parsed.revealedStreams && typeof parsed.revealedStreams === "object") saved = parsed;
            }
          } catch { /* Storage can be unavailable; the game still works. */ }
          if (saved) {
            params.set("rulesVersion", saved.rulesVersion || "v2");
            if (saved.catalogVersion) params.set("catalogVersion", saved.catalogVersion);
          }
        }
        const res = await fetch(withBasePath(`/api/daily?${params.toString()}`));
        if (!res.ok) throw new Error("Couldn't load this hand. Please try again.");
        const data: DailyApiResponse = await res.json();
        if (requestId !== boardRequest.current) return;
        if (accountId && !customSeed && !data.accountState) throw new Error("Your sign-in session changed. Refresh the page before continuing.");
        accountRevision.current = data.accountRevision;
        if (accountId && !customSeed) saved = data.accountState || null;
        setBoard(data);

        // Restore saved state if in Daily Mode
        if (!customSeed) {
          if (saved && [...saved.pickedIds, ...saved.burnedIds].every(id => data.tracks.some(track => track.id === id))) {
            setPickedIds(saved.pickedIds || []);
            setBurnedIds(saved.burnedIds || []);
            setRevealedStreams(saved.revealedStreams || {});
            setShieldAvailable(saved.shieldAvailable ?? true);
            setGameOver(saved.gameOver || false);
            setFinishData(saved.finishData || null);
            const restoredSum = (saved.pickedIds || []).reduce(
              (acc, id) => acc + (saved.revealedStreams?.[id] || 0),
              0
            );
            displaySumRef.current = restoredSum;
            setDisplaySum(restoredSum);
            setLoading(false);
            return;
          }
        }

        // Fresh board reset
        setPickedIds([]);
        setBurnedIds([]);
        setRevealedStreams({});
        setShieldAvailable(true);
        setGameOver(false);
        setFinishData(null);
        displaySumRef.current = 0;
        setDisplaySum(0);
      } catch (cause) {
        if (requestId === boardRequest.current) {
          setBoard(null);
          setError(cause instanceof Error ? cause.message : "Couldn't load this hand.");
        }
      } finally {
        if (requestId === boardRequest.current) setLoading(false);
      }
    },
    [stopAudio, accountId]
  );

  // Account boards roll over together at UTC midnight; existing guest boards keep local dates.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const tomorrow = accountId ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) : new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      );
      const diff = Math.max(0, tomorrow.getTime() - now.getTime());
      const hrs = String(Math.floor(diff / 3600000)).padStart(2, "0");
      const mins = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
      const secs = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
      setCountdown(`${hrs}:${mins}:${secs}`);

      const today = playDate();
      if (board?.date && !practiceSeed && board.date !== today && !requestInFlight.current) {
        void loadBoard(today, null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [board?.date, practiceSeed, loadBoard, accountId, playDate]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void loadBoard(playDate(), null);
    });
    return () => cancelAnimationFrame(frame);
  }, [loadBoard, playDate]);

  const finalizeHand = async (
    finalPickedIds: string[],
    currentRevealed: Record<string, number>,
    currentBurned: string[],
    currentShield: boolean,
    completionCue: "bank" | "complete" = "complete"
  ) => {
    if (!board) return;
    const soundBoard = boardRequest.current;
    stopAudio();
    const res = await fetch(withBasePath("/api/finish"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogVersion: board.catalogVersion,
        rulesVersion: board.rulesVersion,
        date: board.date,
        seed: practiceSeed,
        pickedIds: finalPickedIds,
        accountRevision: accountRevision.current,
      }),
    });
    if (!res.ok) { const message = await res.json().catch(() => ({})); throw new Error(message.error || "Couldn't lock in your hand. Your picks are safe — try Stand again."); }
    const { accountState, ...data }: FinishData & { accountState?: SavedDailyState } = await res.json();
    if (!soundActive.current || soundBoard !== boardRequest.current) return;
    if (accountState) {
      finalPickedIds = accountState.pickedIds;
      currentBurned = accountState.burnedIds;
      currentShield = accountState.shieldAvailable;
      setPickedIds(finalPickedIds);
      setBurnedIds(currentBurned);
      setShieldAvailable(currentShield);
    }
    const mergedStreams = { ...currentRevealed, ...data.allStreams };

    setRevealedStreams(mergedStreams);
    setFinishData(data);
    setGameOver(true);
    if (soundActive.current && soundBoard === boardRequest.current) playSound(data.finalSum > board.targetStreams ? "wrong" : completionCue);

    if (!practiceSeed) {
      saveDailyProgress(board.date, {
        pickedIds: finalPickedIds,
        burnedIds: currentBurned,
        revealedStreams: mergedStreams,
        shieldAvailable: currentShield,
        gameOver: true,
        finishData: data,
      });
      recordCompletedDailyStats(board.date, data.rank);
    }
  };

  const handleCardClick = async (track: PublicTrackCard) => {
    if (
      !board ||
      loading ||
      gameOver ||
      currentSum >= board.targetStreams ||
      requestInFlight.current ||
      busyTrackId ||
      pickedIds.includes(track.id) ||
      burnedIds.includes(track.id)
    ) {
      return;
    }

    requestInFlight.current = true;
    setBusyTrackId(track.id);
    setError(null);
    setShieldToast(null);
    const soundBoard = boardRequest.current;

    try {
      const res = await fetch(withBasePath("/api/reveal"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogVersion: board.catalogVersion,
          rulesVersion: board.rulesVersion,
          date: board.date,
          seed: practiceSeed,
          trackId: track.id,
          accountRevision: accountRevision.current,
        }),
      });
      if (!res.ok) { const message = await res.json().catch(() => ({})); throw new Error(message.error || "Couldn't reveal this track. Please try again."); }
      const data = await res.json();
      if (!soundActive.current || soundBoard !== boardRequest.current) return;
      accountRevision.current = data.accountRevision;
      const trackStreams: number = data.streams;
      if (!Number.isSafeInteger(trackStreams) || trackStreams <= 0) throw new Error("This track's count wasn't available. Please retry.");

      const nextRevealed = { ...revealedStreams, [track.id]: trackStreams };
      setRevealedStreams(nextRevealed);

      const candidateSum = currentSum + trackStreams;

      // Check if player busts the target cap
      if (candidateSum > board.targetStreams) {
        if (shieldAvailable) {
          if (soundActive.current && soundBoard === boardRequest.current) playSound("wrong");
          const nextBurned = [...burnedIds, track.id];
          setBurnedIds(nextBurned);
          setShieldAvailable(false);
          setShieldToast(
            `🛡️ BUST SHIELD SAVED YOU! "${track.title}" (${formatStreams(
              trackStreams
            )}) burned.`
          );

          if (!practiceSeed) {
            saveDailyProgress(board.date, {
              pickedIds,
              burnedIds: nextBurned,
              revealedStreams: nextRevealed,
              shieldAvailable: false,
              gameOver: false,
              finishData: null,
            });
          }
        } else {
          // Second bust -> Game Over
          const nextPicked = [...pickedIds, track.id];
          setPickedIds(nextPicked);
          if (!practiceSeed) saveDailyProgress(board.date, { pickedIds: nextPicked, burnedIds, revealedStreams: nextRevealed, shieldAvailable: false, gameOver: false, finishData: null });
          await finalizeHand(nextPicked, nextRevealed, burnedIds, false);
        }
      } else {
        // Safe hit
        const nextPicked = [...pickedIds, track.id];
        setPickedIds(nextPicked);
        if (!practiceSeed) saveDailyProgress(board.date, { pickedIds: nextPicked, burnedIds, revealedStreams: nextRevealed, shieldAvailable, gameOver: false, finishData: null });

        // New hands remain playable in the 98% zone so exact 100% is reachable.
        if (candidateSum === board.targetStreams || nextPicked.length + burnedIds.length === board.tracks.length || (board.rulesVersion === "v2" && candidateSum >= board.targetStreams * 0.98)) {
          await finalizeHand(
            nextPicked,
            nextRevealed,
            burnedIds,
            shieldAvailable
          );
        } else {
          if (soundActive.current && soundBoard === boardRequest.current) playSound("correct");
          if (!practiceSeed) saveDailyProgress(board.date, {
            pickedIds: nextPicked,
            burnedIds,
            revealedStreams: nextRevealed,
            shieldAvailable,
            gameOver: false,
            finishData: null,
          });
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something interrupted your pick. Try again.");
    } finally {
      requestInFlight.current = false;
      setBusyTrackId(null);
    }
  };

  const handleStand = async () => {
    if (!board || loading || gameOver || pickedIds.length === 0 || requestInFlight.current) return;
    requestInFlight.current = true;
    setFinishing(true);
    setError(null);
    try { await finalizeHand(pickedIds, revealedStreams, burnedIds, shieldAvailable, "bank"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't lock in your hand. Try again."); }
    finally { requestInFlight.current = false; setFinishing(false); }
  };

  const handleShare = async () => {
    if (!board || !finishData) return;
    const pct = ((finishData.finalSum / board.targetStreams) * 100).toFixed(1);
    const gridRows: string[] = [];

    for (let i = 0; i < 9; i += 3) {
      const row = board.tracks
        .slice(i, i + 3)
        .map((t) => {
          if (pickedIds.includes(t.id)) return "🟩";
          if (burnedIds.includes(t.id)) return "🛡️";
          if (finishData.optimalHandIds.includes(t.id)) return "⭐";
          return "⬛";
        })
        .join("");
      gridRows.push(row);
    }

    const modeTitle = practiceSeed
      ? `Stream Blackjack (Practice)`
      : `Stream Blackjack — Day #${board.puzzleNumber}`;

    const shareText = [
      `🎧 ${modeTitle}`,
      `🎯 ${formatStreams(finishData.finalSum)} / ${formatStreams(
        board.targetStreams
      )} (${pct}%) — ${finishData.rank}`,
      `🔥 Streak: ${stats.currentStreak}`,
      "",
      ...gridRows,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(shareText);
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2500);
    } catch { setError("Copying isn't available in this browser. Your score is still saved here."); }
  };

  const switchMode = (newSeed: string | null) => {
    if (requestInFlight.current || loading) return;
    setPracticeSeed(newSeed);
    window.scrollTo(0, 0);
    void loadBoard(playDate(), newSeed).then(() => {
      requestAnimationFrame(() => window.scrollTo(0, 0));
    });
  };

  const targetStreams = board?.targetStreams || 4500000000;
  const fillPercent = Math.min(100, (currentSum / targetStreams) * 100);
  const rawPercent = ((currentSum / targetStreams) * 100).toFixed(1);
  const headroom = Math.max(0, targetStreams - currentSum);
  const isBust = currentSum > targetStreams;

  return (
    <div className="bj-experience min-h-screen pb-16 text-white selection:bg-[#c4f58a] selection:text-black">
      <a href="#game" className="skip-link">Skip to game</a>
      <BlackjackStage />
      {/* MUSICAL DAILY NAVIGATION */}
      <header className="bj-header md-arcade-header sticky top-0 z-30 border-b border-white/10 bg-[#0c0b12]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3.5">
          <MusicalDailyBrand href={hubUrl} showBack />

          {/* Right Controls: Streak, Stats, Mode Switcher, Help */}
          <div className="flex items-center gap-2">
            <AccountButton statsHref="/stats" />
            {/* Streak Pill */}
            <button
              onClick={() => setShowStatsModal(true)}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#191724] px-3 py-1.5 text-sm font-bold transition hover:border-[#c4f58a]/50 hover:bg-[#252137]"
              title="View Streak & Career Stats"
            >
              <span className="text-sm" aria-hidden="true">ϟ</span>
              <span>{stats.currentStreak}</span>
              <span className="hidden text-neutral-400 sm:inline">day streak</span>
            </button>

            {/* Dedicated game stats */}
            <a
              href={withBasePath("/stats")}
              className="md-game-stats-link"
            >
              My stats ↗
            </a>

            {/* Daily vs Unlimited Practice Toggle */}
            {practiceSeed ? (
              <button
                onClick={() => switchMode(null)}
                disabled={loading || !!busyTrackId || finishing}
                className="rounded-full bg-[#c4f58a] px-3 py-1.5 text-sm font-bold text-black transition hover:bg-[#dcffb7]"
              >
                Back to Daily
              </button>
            ) : (
              <button
                onClick={() => switchMode(String(Date.now()))}
                disabled={loading || !!busyTrackId || finishing}
                className="rounded-full border border-white/10 bg-[#191724] px-3 py-1.5 text-sm font-semibold text-neutral-300 transition hover:border-[#c4f58a]/50 hover:text-white"
              >
                ∞ Free Play
              </button>
            )}

            {/* How to Play */}
            <button
              onClick={() => setShowHelpModal(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#191724] text-sm font-bold text-neutral-300 transition hover:border-white/30 hover:text-white"
              aria-label="How to Play"
            >
              ?
            </button>
          </div>
        </div>
      </header>

      <main id="game" className="bj-main mx-auto max-w-5xl px-4 pt-6">
        <div className="game-heading"><div><h1>Stream <em>Blackjack</em><span>.</span></h1><p>Trust your music instinct. Know when to stand.</p></div><div className="bj-edition"><BlackjackEmblem /><span className="edition-badge">{practiceSeed ? "FREE PLAY" : board ? `DAILY MIX #${String(board.puzzleNumber).padStart(3, "0")}` : "DEALING YOUR MIX"}</span></div></div>
        {error && <div role="alert" className="game-error"><span>{error}</span>{(!board || accountId) && <button onClick={() => void loadBoard(playDate(), practiceSeed)}>Reload saved hand ↻</button>}</div>}
        <aside className="bj-challenge mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#c4f58a]/20 bg-[#c4f58a]/[0.06] px-4 py-3 text-sm text-neutral-300 sm:text-sm">
          <span>Hit tracks to build your total, then stand before you bust.</span>
          <span className="hidden text-neutral-500 sm:inline">Your shield saves one risky pick.</span>
          <span className="font-bold text-white">{board?.rulesVersion === "v2" ? "Can you land within 2% of the cap?" : "An exact 100% hand is always on the board."}</span>
        </aside>

        {/* HUD METER / STREAM CONSOLE */}
        <section
          data-bust={isBust || undefined}
          data-blackjack={currentSum >= targetStreams * 0.98 && !isBust || undefined}
          className={`bj-console relative mb-6 overflow-hidden rounded-2xl border p-5 transition-all duration-300 ${
            isBust
              ? "border-red-500/50 bg-gradient-to-b from-red-950/40 to-[#14121d]"
              : currentSum >= targetStreams * 0.98
              ? "border-[#c4f58a] bg-gradient-to-b from-[#c4f58a]/20 to-[#14121d] shadow-[0_0_35px_rgba(167,139,250,0.2)]"
              : "border-white/10 bg-[#14121d]/90"
          }`}
        >
          <div className="bj-console-top"><span><i aria-hidden="true" />{gameOver ? "Hand complete" : "Build your hand"}</span><span className="bj-console-eq" aria-hidden="true"><i /><i /><i /><i /><i /></span></div>
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            {/* Odometer Readout */}
            <div>
              <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-neutral-400">
                <span>Current Hand Total</span>
                <span className="text-neutral-600">•</span>
                <span className="text-[#dcffb7]">
                  {pickedIds.length} {pickedIds.length === 1 ? "Track" : "Tracks"} Picked
                </span>
              </div>
              <div className="bj-readout mt-1 flex items-baseline gap-3">
                <span
                  className={`font-mono text-4xl font-black tracking-tight sm:text-5xl ${
                    isBust ? "text-red-400" : "text-white"
                  }`}
                >
                  {formatStreams(displaySum)}
                </span>
                <span className="font-mono text-lg text-neutral-400 sm:text-xl">
                  / {formatStreams(targetStreams)} Cap
                </span>
              </div>
              <p className="mt-2 font-mono text-sm text-neutral-400">Exact cap: <span className="text-neutral-200">{targetStreams.toLocaleString("en-US")}</span> streams</p>
              {currentSum >= targetStreams * 0.98 && currentSum < targetStreams && !gameOver && <p className="mt-2 text-sm text-violet-200">Blackjack secured. Stand now, or risk another pick for 100%.</p>}
            </div>

            {/* Right Controls: Shield Badge + Stand Button */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Bust Shield Indicator */}
              <div
                className={`flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-bold transition ${
                  shieldAvailable
                    ? "border-[#c4f58a]/40 bg-[#c4f58a]/10 text-[#dcffb7]"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                }`}
              >
                <span>{shieldAvailable ? "🛡️" : "💥"}</span>
                <span>
                  {shieldAvailable ? "Bust Shield Ready" : "Shield Burned"}
                </span>
              </div>

              {/* Stand Button */}
              {!gameOver && (
                <button
                  onClick={handleStand}
                  disabled={loading || pickedIds.length === 0 || !!busyTrackId || finishing}
                  className="bj-stand md-arcade-button rounded-full bg-[#c4f58a] px-6 py-2.5 text-sm font-extrabold tracking-wide text-black shadow-[0_4px_20px_rgba(167,139,250,0.4)] transition hover:scale-[1.03] hover:bg-[#dcffb7] active:scale-95 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500 disabled:shadow-none"
                >
                  {finishing ? "LOCKING IN…" : "STAND & LOCK IN"}
                </button>
              )}

              {practiceSeed && gameOver && (
                <button
                  onClick={() => switchMode(String(Date.now()))}
                  className="md-arcade-button rounded-full bg-[#c4f58a] px-5 py-2.5 text-sm font-extrabold text-black transition hover:bg-[#dcffb7]"
                >
                  🔄 Deal New Hand
                </button>
              )}
            </div>
          </div>

          {/* PROGRESS BAR WITH 90% GOLD & 98% BLACKJACK MARKERS */}
          <div className="mt-5">
            <div className="bj-stream-meter relative h-4 w-full overflow-hidden rounded-full bg-neutral-900 p-0.5 ring-1 ring-white/10">
              {/* 90% Gold Zone Marker */}
              <div
                className="absolute top-0 bottom-0 z-10 border-l border-dashed border-amber-400/70"
                style={{ left: "90%" }}
                title="90% Gold Record Zone"
              />
              {/* 98% Blackjack Zone Highlight */}
              <div
                className="absolute top-0 bottom-0 z-10 bg-[#c4f58a]/25 border-l border-[#c4f58a]"
                style={{ left: "98%", width: "2%" }}
                title="98%-100% Blackjack Zone"
              />

              {/* Animated Bar */}
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${
                  isBust
                    ? "bg-gradient-to-r from-red-600 to-red-400"
                    : currentSum >= targetStreams * 0.98
                    ? "bg-gradient-to-r from-[#c4f58a] to-[#dcffb7] shadow-[0_0_15px_#c4f58a]"
                    : currentSum >= targetStreams * 0.9
                    ? "bg-gradient-to-r from-[#c4f58a] to-amber-400"
                    : "bg-[#c4f58a]"
                }`}
                style={{ width: `${fillPercent}%` }}
              />
            </div>

            {/* Sub-bar Telemetry */}
            <div className="mt-2 flex items-center justify-between text-sm font-medium text-neutral-400">
              <span>{rawPercent}% of Target Cap</span>
              <div className="flex items-center gap-4">
                <span className="hidden sm:inline text-amber-400/90">
                  💿 90% Gold ({formatStreams(targetStreams * 0.9)})
                </span>
                <span className="hidden sm:inline text-[#dcffb7]">
                  🃏 98% Blackjack ({formatStreams(targetStreams * 0.98)})
                </span>
                <span className="font-mono font-semibold text-white">
                  {isBust
                    ? `BUSTED BY ${formatStreams(currentSum - targetStreams)}`
                    : `${formatStreams(headroom)} Headroom Left`}
                </span>
              </div>
            </div>
          </div>

          {/* BUST SHIELD TOAST ALERT */}
          {shieldToast && (
            <div className="animate-shake mt-4 flex items-center justify-between rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-200">
              <span>{shieldToast}</span>
              <button
                onClick={() => setShieldToast(null)}
                className="ml-3 text-amber-300 hover:text-white"
              >
                ✕
              </button>
            </div>
          )}
        </section>

        {/* POST-GAME RESULTS & OPTIMAL HAND BANNER */}
        {gameOver && finishData && board && (
          <section className="bj-results mb-6 rounded-2xl border border-[#c4f58a]/40 bg-gradient-to-br from-[#191724] via-[#14121d] to-[#241a3b] p-5 shadow-2xl">
            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full bg-[#c4f58a]/20 px-3 py-1 text-sm font-extrabold uppercase tracking-wider text-[#dcffb7]">
                  <span>
                    {finishData.rank === "BLACKJACK"
                      ? "🃏 BLACKJACK!"
                      : finishData.rank === "GOLD RECORD"
                      ? "💿 GOLD RECORD"
                      : finishData.rank === "CHARTING"
                      ? "📻 CHARTING"
                      : finishData.rank === "SOUNDCHECK"
                      ? "🛋️ SOUNDCHECK"
                      : "💥 BUSTED"}
                  </span>
                  <span>•</span>
                  <span>
                    {((finishData.finalSum / board.targetStreams) * 100).toFixed(
                      1
                    )}
                    % Accuracy
                  </span>
                </div>

                <h2 className="mt-2 text-2xl font-black">
                  You locked in {formatStreams(finishData.finalSum)} /{" "}
                  {formatStreams(board.targetStreams)}
                </h2>
                <p className="mt-1 text-sm text-neutral-300">
                  Today&apos;s Optimal Hand reached{" "}
                  <span className="font-bold text-[#dcffb7]">
                    {formatStreams(finishData.optimalSum)} (
                    {(
                      (finishData.optimalSum / board.targetStreams) *
                      100
                    ).toFixed(1)}
                    %)
                  </span>{" "}
                  — look for the{" "}
                  <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-sm font-bold text-amber-300">
                    ★ Best hand
                  </span>{" "}
                  badges on the board below.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {!practiceSeed && (
                  <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-center">
                    <div className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                      Next Daily Drop
                    </div>
                    <div className="font-mono text-lg font-extrabold text-[#dcffb7]">
                      {countdown}
                    </div>
                  </div>
                )}

                <button
                  onClick={handleShare}
                  className="md-arcade-button flex items-center gap-2 rounded-full bg-[#c4f58a] px-5 py-3 text-sm font-extrabold text-black shadow-[0_4px_20px_rgba(167,139,250,0.4)] transition hover:scale-105 hover:bg-[#dcffb7]"
                >
                  <span>{copiedShare ? "✅ Copied Grid!" : "📤 Share Score"}</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {gameOver && finishData && board && <HandRemix key={board.seedKey} tracks={board.tracks} streams={finishData.allStreams} target={board.targetStreams} original={pickedIds} />}

        {/* NINE-TRACK BOARD */}
        <div className="bj-board-heading"><h2>{gameOver ? "Your final mix" : "Pick your next track"}</h2><span aria-hidden="true">↙</span></div>
        {loading ? (
          <div className="bj-board grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, idx) => (
              <div
                key={idx}
                className="h-36 animate-pulse rounded-2xl border border-white/5 bg-[#191724] p-4"
              />
            ))}
          </div>
        ) : (
          <div className="bj-board grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {board?.tracks.map((track, index) => {
              const isPicked = pickedIds.includes(track.id);
              const isBurned = burnedIds.includes(track.id);
              const isOptimal =
                gameOver && finishData?.optimalHandIds.includes(track.id);
              const streams = revealedStreams[track.id];
              const isPlaying = playingTrackId === track.id;
              const isLoadingPreview = loadingPreviewId === track.id;

              return (
                <div
                  key={track.id}
                  data-state={isPicked ? "picked" : isBurned ? "burned" : isOptimal ? "optimal" : gameOver ? "revealed" : "ready"}
                  style={{ "--card-index": index } as React.CSSProperties}
                  onClick={() => handleCardClick(track)}
                  role="button"
                  aria-disabled={loading || gameOver || isPicked || isBurned || !!busyTrackId || finishing}
                  aria-label={`${track.title} by ${track.artist}${streams !== undefined ? `, ${streams.toLocaleString("en-US")} streams` : ", reveal stream count"}`}
                  tabIndex={gameOver || isPicked || isBurned ? -1 : 0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleCardClick(track);
                    }
                  }}
                  className={`bj-track-card group relative flex flex-col justify-between overflow-hidden rounded-2xl border p-4 text-left transition-all duration-200 ${
                    isPicked
                      ? "border-[#c4f58a] bg-gradient-to-br from-[#c4f58a]/20 via-[#191724] to-[#100e18] shadow-[0_0_25px_rgba(167,139,250,0.18)]"
                      : isBurned
                      ? "border-amber-500/40 bg-amber-950/20 opacity-80"
                      : gameOver
                      ? isOptimal
                        ? "border-amber-400/60 bg-[#1c1a12]"
                        : "border-white/10 bg-[#171420] opacity-85"
                      : "cursor-pointer border-white/10 bg-[#191724] hover:-translate-y-1 hover:border-[#c4f58a]/60 hover:bg-[#252137] hover:shadow-xl"
                  }`}
                >

                  {/* Top Row: Album Cover + Track Metadata */}
                  <div className="flex items-start gap-3.5">
                    {/* Album Cover Wrapper */}
                    <div className="bj-artwork relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-neutral-900 shadow-lg ring-1 ring-white/10">
                      <TrackArtwork key={`${board.seedKey}:${track.id}`} track={track} query={new URLSearchParams({ date: board.date, catalogVersion: board.catalogVersion, rulesVersion: board.rulesVersion, ...(practiceSeed ? { seed: practiceSeed } : {}) }).toString()} />

                      {/* 30s Audio Preview Play Button Overlay */}
                        <button
                          type="button"
                          onClick={(e) => toggleAudioPreview(e, track)}
                          onKeyDown={(e) => e.stopPropagation()}
                          aria-label={`${isPlaying ? "Pause" : isLoadingPreview ? "Cancel loading" : "Play"} preview of ${track.title}`}
                          aria-busy={isLoadingPreview}
                          title={
                            isPlaying ? "Pause 30s preview" : isLoadingPreview ? "Cancel preview lookup" : "Play 30s preview"
                          }
                          className={`absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full shadow-md transition ${
                            isPlaying
                              ? "bg-[#c4f58a] text-black scale-105"
                              : "bg-black/75 text-white opacity-90 hover:bg-[#c4f58a] hover:text-black"
                          }`}
                        >
                          {isPlaying ? "⏸" : isLoadingPreview ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : "▶"}
                        </button>
                    </div>

                    {/* Track Title, Artist & Badges */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-xs font-semibold text-neutral-300">
                          {track.releaseYear}
                        </span>
                        {isPicked && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-[#c4f58a] px-2 py-0.5 text-xs font-extrabold uppercase text-black">
                            <span>Picked</span>
                          </span>
                        )}
                        {isBurned && (
                          <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-extrabold uppercase text-amber-300">
                            🛡️ Shield used
                          </span>
                        )}
                        {isOptimal && (
                          <span className="rounded-md bg-amber-400/20 px-2 py-0.5 text-xs font-extrabold uppercase text-amber-300">
                            ★ OPTIMAL
                          </span>
                        )}
                      </div>

                      <h3 className="mt-1.5 line-clamp-1 text-base font-bold text-white group-hover:text-[#dcffb7]">
                        {track.title}
                      </h3>
                      <p className="line-clamp-1 text-sm font-medium text-neutral-400">
                        {track.artist}
                      </p>
                      <p role="status" className="mt-1 text-xs leading-snug text-neutral-400">
                        {isLoadingPreview ? "Finding a preview…" : isPlaying ? "Playing · 30s preview" : previewMessages[track.id] || (track.previewStatus === "unavailable" ? "Preview unavailable · tap to check again" : "Tap ▶ for a 30s preview")}
                      </p>
                      {track.previewSourceUrl && <a href={track.previewSourceUrl} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} className="mt-1 inline-block text-xs text-[#dcffb7] underline underline-offset-2">Listen on Apple Music ↗</a>}
                    </div>
                  </div>

                  {/* Bottom Footer: Stream Count Reveal or Hit Action */}
                  <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
                    {streams !== undefined ? (
                      <>
                        <div className="flex items-center gap-2">
                          {isPicked && (
                            <div className="flex items-end gap-0.5 h-4">
                              <span className="w-1 bg-[#c4f58a] rounded-full eq-bar-1" />
                              <span className="w-1 bg-[#c4f58a] rounded-full eq-bar-2" />
                              <span className="w-1 bg-[#c4f58a] rounded-full eq-bar-3" />
                            </div>
                          )}
                          <span
                            className={`font-mono text-lg font-black ${
                              isPicked
                                ? "text-[#dcffb7]"
                                : isBurned
                                ? "line-through text-amber-400"
                                : "text-white"
                            }`}
                          >
                            {formatStreams(streams)}
                          </span>
                          <span className="text-xs text-neutral-400">
                            streams
                          </span>
                        </div>
                        <span className="rounded-full bg-white/10 px-2.5 py-0.5 font-mono text-sm font-semibold text-neutral-300">
                          {((streams / board.targetStreams) * 100).toFixed(1)}%
                          of cap
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-neutral-400 group-hover:text-neutral-200">
                          {busyTrackId === track.id
                            ? "Revealing streams..."
                            : "Pick this track"}
                        </span>
                        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-white/5 text-sm font-bold text-[#dcffb7] transition group-hover:border-[#c4f58a] group-hover:bg-[#c4f58a] group-hover:text-black">
                          +
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <footer className="game-footer"><a href={hubUrl}>← More games on Musical Daily</a><span>Real stream counts. Your intuition.</span></footer>
      </main>

      {/* STATS & STREAK MODAL */}
      {showStatsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setShowStatsModal(false)}
        >
          <div
            className="bj-dialog w-full max-w-md rounded-2xl border border-white/15 bg-[#191724] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black tracking-tight">
                YOUR CAREER STATS
              </h3>
              <button
                onClick={() => setShowStatsModal(false)}
                className="text-neutral-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2 text-center">
              <div className="rounded-xl bg-[#100e18] p-3">
                <div className="font-mono text-2xl font-black text-white">
                  {stats.played}
                </div>
                <div className="text-xs text-neutral-400">Played</div>
              </div>
              <div className="rounded-xl bg-[#100e18] p-3">
                <div className="font-mono text-2xl font-black text-[#dcffb7]">
                  {stats.currentStreak} 🔥
                </div>
                <div className="text-xs text-neutral-400">Streak</div>
              </div>
              <div className="rounded-xl bg-[#100e18] p-3">
                <div className="font-mono text-2xl font-black text-white">
                  {stats.maxStreak}
                </div>
                <div className="text-xs text-neutral-400">Max Streak</div>
              </div>
              <div className="rounded-xl bg-[#100e18] p-3">
                <div className="font-mono text-2xl font-black text-amber-400">
                  {stats.blackjacks}
                </div>
                <div className="text-xs text-neutral-400">Blackjacks</div>
              </div>
            </div>

            {!accountId && <><h4 className="mt-6 text-sm font-bold uppercase tracking-wider text-neutral-400">
              Rank Distribution
            </h4>
            <div className="mt-3 space-y-2 text-sm">
              {(
                [
                  "BLACKJACK",
                  "GOLD RECORD",
                  "CHARTING",
                  "SOUNDCHECK",
                  "BUST",
                ] as RankTier[]
              ).map((tier) => {
                const count = stats.tierCounts[tier] || 0;
                const pct =
                  stats.played > 0
                    ? Math.max(8, Math.round((count / stats.played) * 100))
                    : 8;
                return (
                  <div key={tier} className="flex items-center gap-3">
                    <span className="w-28 font-semibold text-neutral-300">
                      {tier}
                    </span>
                    <div className="flex-1 overflow-hidden rounded-full bg-[#100e18]">
                      <div
                        className="rounded-full bg-[#c4f58a] px-2 py-1 text-right font-mono font-bold text-black"
                        style={{ width: `${pct}%` }}
                      >
                        {count}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div></>}
            <p className="mt-5 text-sm text-neutral-400">{accountId ? "Daily results sync with your Musical Daily account." : "Guest daily results stay in this browser."}</p>
            {accountId && <a className="mt-3 inline-block text-sm text-[#dcffb7] underline" href={`${hubUrl.replace(/\/$/, "")}/stats`}>See all your games ↗</a>}
          </div>
        </div>
      )}

      {/* HOW TO PLAY MODAL */}
      {showHelpModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setShowHelpModal(false)}
        >
          <div
            className="bj-dialog w-full max-w-md rounded-2xl border border-white/15 bg-[#191724] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black">HOW TO PLAY</h3>
              <button
                onClick={() => setShowHelpModal(false)}
                className="text-neutral-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <ul className="mt-4 space-y-3 text-sm text-neutral-300">
              <li>
                🎯 <strong>The Goal:</strong> Pick tracks from the 3×3 grid so
                their combined Spotify streams get as close to the{" "}
                <strong>Daily Cap</strong> as possible without going over.
              </li>
              <li>
                🛡️ <strong>1 Bust Shield:</strong> If a pick pushes you over the
                cap, your Bust Shield burns that track and keeps your hand alive.
                A second bust ends the round!
              </li>
              <li>
                🃏 <strong>Scoring Tiers:</strong>
                <ul className="mt-1.5 ml-4 space-y-1 text-sm text-neutral-400">
                  <li>
                    <strong className="text-[#dcffb7]">98% – 100%:</strong>{" "}
                    BLACKJACK. {board?.rulesVersion === "v2" ? "Auto-locks at 98%." : "Stand here, or chase a perfect 100%."}
                  </li>
                  <li>
                    <strong className="text-amber-300">90% – 97.9%:</strong>{" "}
                    GOLD RECORD
                  </li>
                  <li>
                    <strong>75% – 89.9%:</strong> CHARTING
                  </li>
                </ul>
              </li>
              <li>
                🔊 <strong>Audio Previews:</strong> Tap the ▶ button on any
                album cover to listen to a 30-second snippet while deciding.
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
