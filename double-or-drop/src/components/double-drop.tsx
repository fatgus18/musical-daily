"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hubHref, withBasePath } from "@/lib/app-path";
import { AccountButton, guestOnly, useAccount } from "./account-client";
import { MusicalDailyBrand } from "./musical-daily-brand";
import { useSound, useBackgroundMusic } from "./sound-client";
import { useSongPreview } from "./song-preview";
import { ArtistCollectionSearch } from "./artist-collection-search";
import { CollectionPicker } from "./collection-picker";
import { useFinalLossReveal } from "./final-loss-reveal";
import { DropBuddies } from "./drop-buddies";
import { BankTargetPicker, GoalOutcome, RunGoalRibbon } from "./run-goals";
import { runMilestone, type BankTarget } from "@/lib/run-goals";
import type { CatalogTheme, Metric } from "@/lib/catalog-types";
import type { GameMode, MetricFilter, Move, PublicGame, PublicTrack, Side, ValueReveal } from "@/lib/types";

const HUB = hubHref();
const number = (value: number) => value.toLocaleString("en-US");
const compact = (value: number) => value < 1_000_000 ? number(value) : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const metricNames: Record<MetricFilter, string> = { mixed: "Mix it up", streams: "Streams", duration: "Runtime", tempo: "Tempo", year: "Release year" };
const metricIcons: Record<MetricFilter, string> = { mixed: "✳", streams: "↗", duration: "◷", tempo: "≋", year: "↶" };

interface CatalogInfo {
  version: string; createdAt: string; tracks: number; artists: number;
  metrics: Partial<Record<Metric, number>>; themes: CatalogTheme[];
}
interface Payload { game: PublicGame | null; catalog?: CatalogInfo; daily?:{date:string;resetsAt:number}; personalBest?: number | null; statsSynced?: boolean; error?: string }

async function readResponse(response: Response): Promise<Payload> {
  const result = await response.json().catch(() => ({ error: "The game service didn’t respond. Please try again." })) as Payload;
  if (!response.ok) throw Object.assign(new Error(result.error || "Something interrupted that move. Please try again."), { game: result.game });
  return result;
}

export function DoubleDrop() {
  const { user, loading } = useAccount();
  return <>
    <a className="skip-link" href="#game">Skip to game</a>
    <header className="site-header md-arcade-header">
      <MusicalDailyBrand href={HUB} showBack />
      <div className="header-account-links"><a className="local-stats-link" href={withBasePath("/stats")}>My stats ↗</a><AccountButton statsHref={withBasePath("/stats")} /></div>
    </header>
    {loading ? <main className="loading-screen" aria-live="polite"><span className="loading-record" /><p>Getting the records ready…</p></main> : <RunClient key={user?.id || "guest"} signedIn={Boolean(user)} />}
    <footer className="site-footer"><span>A little knowledge. A little nerve.</span><a href={HUB}>Made for your music brain <span aria-hidden="true">✳</span></a></footer>
  </>;
}

function RunClient({ signedIn }: { signedIn: boolean }) {
  const [mode,setMode]=useState<GameMode>("unlimited");
  const modeRef=useRef<GameMode>("unlimited");
  const [daily,setDaily]=useState<Payload["daily"]>();
  const [game, setGame] = useState<PublicGame | null>(null);
  const latestGame = useRef<PublicGame | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<string | null>(null);
  const [loadingCollection, setLoadingCollection] = useState(false);
  const [clock, setClock] = useState(0);
  const clockAnchor = useRef({ received: 0, serverNow: 0 });
  const timeoutAttempt = useRef(0);
  const lastTick = useRef("");
  const [feedback, setFeedback] = useState<{ revision: number; kind: "good" | "bad" } | null>(null);
  const { play: sound, unlock } = useSound();
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [lobby, setLobby] = useState(true);
  const [theme, setTheme] = useState<CatalogTheme | null>(null);
  const [metric, setMetric] = useState<MetricFilter>("mixed");
  const [bankTarget, setBankTarget] = useState<BankTarget | null>(null);
  const [personalBest, setPersonalBest] = useState<number | null>(null);
  const [milestone, setMilestone] = useState<string | null>(null);
  const [statsSynced, setStatsSynced] = useState(true);
  const [shareLabel, setShareLabel] = useState("Copy result ↗");
  const lock = useRef(false);
  const createId = useRef<string | null>(null);
  const help = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);

  const remaining = game?.guessDeadline ? Math.max(0, (game.guessDeadline - clockAnchor.current.serverNow - (clock - clockAnchor.current.received)) / 1000) : 0;
  const expired = game?.phase === "guess" && remaining <= 0;
  const urgent = game?.phase === "guess" && remaining <= 5;
  const showFinalReveal = useFinalLossReveal(game, !lobby);
  const preview = useSongPreview(`${game?.id}:${game?.round}:${game?.phase}:${lobby}`, Boolean(game && game.pair.metric === "tempo" && !lobby && game.phase !== "complete" && !expired));
  useBackgroundMusic(Boolean(game && !lobby && game.phase !== "complete"));

  const accept = useCallback((data: Payload) => {
    const previous = latestGame.current, incoming = data.game;
    if (previous && incoming?.id === previous.id && incoming.revision < previous.revision) return;
    const nextMilestone = runMilestone(previous, incoming);
    if (nextMilestone) setMilestone(nextMilestone);
    if (previous?.id !== incoming?.id) setMilestone(null);
    if (data.personalBest !== undefined) setPersonalBest(data.personalBest);
    if (previous && incoming?.id === previous.id && incoming.revision > previous.revision) {
      preview.stop();
      if (incoming.banked > previous.banked) sound("bank");
      else if (incoming.answered > previous.answered) {
        sound(incoming.reveal?.timedOut ? "timeout" : incoming.reveal?.correct ? "correct" : "wrong");
        setFeedback({ revision: incoming.revision, kind: incoming.reveal?.correct ? "good" : "bad" });
      } else if (incoming.phase === "guess" && previous.phase === "decision" && incoming.pot > 0) sound("risk");
    }
    const now = performance.now();
    clockAnchor.current = { received: now, serverNow: incoming?.serverNow || Date.now() };
    setClock(now); latestGame.current = incoming; setGame(incoming);
    if (data.catalog) setCatalog(data.catalog);
    if(data.daily)setDaily(data.daily);
    setStatsSynced(data.statsSynced !== false);
  }, [preview.stop, sound]);

  useEffect(() => {
    if (!milestone) return;
    const timer = setTimeout(() => setMilestone(null), 4200);
    return () => clearTimeout(timer);
  }, [milestone]);

  const refresh = useCallback(async (showSaved: boolean,selectedMode=modeRef.current) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      const data = await readResponse(await fetch(withBasePath(`/api/game?mode=${selectedMode}`), { cache: "no-store", signal: abort.signal }));
      if (controller.current !== abort) return;
      accept(data);
      if (showSaved && data.game) setLobby(data.game.completionStatus === "incomplete");
      if(selectedMode==="daily"&&!data.game)setLobby(true);
    } catch {
      if (controller.current === abort) setError("We couldn’t load your saved run. Check your connection and try again.");
    } finally { clearTimeout(timeout); if (controller.current === abort) { lock.current = false; setBusy(false); } }
  }, [accept]);

  useEffect(() => {
    const selectedMode=new URLSearchParams(window.location.search).get("mode")==="daily"?"daily":"unlimited";
    modeRef.current=selectedMode;setMode(selectedMode);
    void refresh(selectedMode!=="daily",selectedMode);
    return () => { controller.current?.abort(); controller.current = null; lock.current = false; };
  }, [refresh]);

  useEffect(()=>{
    if(mode!=="daily"||!daily)return;
    const check=()=>{if(Date.now()>=daily.resetsAt&&!lock.current)void refresh(false,"daily");};
    const timer=setInterval(check,10000);window.addEventListener("focus",check);
    return ()=>{clearInterval(timer);window.removeEventListener("focus",check);};
  },[mode,daily,refresh]);

  function freshSetup() {
    setLobby(true); setTheme(null); setCatalogVersion(null); setMetric("mixed"); setFeedback(null); setMilestone(null); createId.current = null;
  }
  function changeMode(next:GameMode){
    if(lock.current||loadingCollection)return;
    modeRef.current=next;setMode(next);latestGame.current=null;setGame(null);freshSetup();
    const url=new URL(window.location.href);url.searchParams.set("mode",next);window.history.replaceState(null,"",url);
    void refresh(false,next);
  }

  async function act(action: Move | "create", choice?: Side) {
    if (lock.current || (action !== "create" && !game)) return;
    lock.current = true; setBusy(true); setError(""); setShareLabel("Copy result ↗");
    if (action !== "timeout") unlock();
    if (action === "guess" || action === "timeout" || action === "bank" || action === "risk" || action === "cashout" || action === "discard") preview.stop();
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      if (action === "create") createId.current ||= crypto.randomUUID();
      const body = action === "create"
        ? mode==="daily"?{action,requestId:createId.current,mode}:{ action, mode,requestId: createId.current, theme: theme?.id || "all", metricFilter: metric, bankTarget, ...(catalogVersion ? { catalogVersion } : {}) }
        : { action, gameId: game!.id, revision: game!.revision, round: game!.round, ...(choice ? { choice } : {}) };
      let data = await readResponse(await fetch(withBasePath("/api/game"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal }));
      if (controller.current !== abort) return;
      // A deadline may have consumed the submitted revision. Discard only this same run,
      // once more at its saved revision; never target a replacement from another tab.
      if (action === "discard" && data.game && data.game.id === game?.id && data.game.phase !== "complete") {
        const current = data.game;
        data = await readResponse(await fetch(withBasePath("/api/game"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, gameId: current.id, round: current.round, revision: current.revision }), signal: abort.signal }));
        if (controller.current !== abort) return;
        if (data.game?.phase !== "complete") throw new Error("This run changed in another tab. Please try discarding it again.");
      }
      accept(data); if (action === "discard") freshSetup(); else if (action !== "timeout") setLobby(false); createId.current = null;
      if (action === "create") { setFeedback(null); sound("start"); }
    } catch (failure) {
      // A timed-out response can still have committed. Read the saved revision before allowing another move.
      if (controller.current !== abort) return;
      const message = failure instanceof Error ? failure.message : "That move didn’t reach us. Please try again.";
      try {
        const saved = await readResponse(await fetch(withBasePath(`/api/game?mode=${mode}`), { cache: "no-store", signal: AbortSignal.timeout(12000) }));
        if (controller.current !== abort) return;
        accept(saved);
        if (action === "discard" && saved.game?.id === game?.id && saved.game?.phase === "complete") { freshSetup(); setError(""); return; }
        if (saved.game && (action === "create" || saved.game.revision !== game?.revision)) { if (action !== "timeout" && action !== "discard") setLobby(false); createId.current = null; }
      } catch { /* Keep the visible revision; server rejects a stale retry safely. */ }
      if (controller.current === abort) setError(message === "This operation was aborted" ? "That response took too long. We’ve checked for a saved move; please try again." : message);
    } finally { clearTimeout(timeout); if (controller.current === abort) { lock.current = false; setBusy(false); } }
  }

  useEffect(() => {
    if (game?.phase !== "guess") return;
    const timer = setInterval(() => setClock(performance.now()), 100);
    const visible = () => { if (document.visibilityState === "visible") setClock(performance.now()); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [game?.id, game?.round, game?.phase]);

  useEffect(() => {
    if (!expired || busy || lock.current || clock < timeoutAttempt.current) return;
    timeoutAttempt.current = clock + 1000;
    void act("timeout");
  });

  useEffect(() => {
    const second = Math.ceil(remaining), key = `${game?.id}:${game?.round}:${second}`;
    if (game?.phase === "guess" && second > 0 && second <= 5 && !lobby && key !== lastTick.current) {
      lastTick.current = key; sound("tick");
    }
  }, [remaining, game?.id, game?.round, game?.phase, lobby, sound]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || busy || lobby || !game || help.current?.open) return;
      if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
      if (game.phase === "guess" && !expired && (event.key === "1" || event.key === "2")) { event.preventDefault(); void act("guess", event.key === "1" ? "left" : "right"); }
      if (game.phase === "decision" && event.key.toLowerCase() === "b") { event.preventDefault(); void act("bank"); }
      if (game.phase === "decision" && game.canRisk && event.key.toLowerCase() === "r") { event.preventDefault(); void act("risk"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const active = game && game.phase !== "complete";
  const incomplete = game?.completionStatus === "incomplete";
  const selectedTheme = theme || catalog?.themes[0];
  const available = selectedTheme?.metrics || [];
  const changeTheme = (next: CatalogTheme, version?: string) => {
    setTheme(next); setCatalogVersion(version || null); createId.current = null;
    if (metric !== "mixed" && !next.metrics.includes(metric)) setMetric("mixed");
  };

  async function share() {
    if (!game) return;
    try {
      await navigator.clipboard.writeText(`Double or Drop ✳${game.mode==="daily"?` Daily · ${game.dailyDate}`:" Unlimited"}\n${game.mode==="daily"?Array.from({length:10},(_,i)=>game.results[i]?game.results[i].correct?"🟪":"⬛":"⬜").join("")+"\n":""}${number(game.banked)} points banked · ${game.correct}/${game.answered} correct\nBest streak: ${game.bestStreak}\n${window.location.origin}${withBasePath("/")}${game.mode==="daily"?"?mode=daily":""}`);
      setShareLabel("Copied ✓");
    } catch { setShareLabel("Copy unavailable"); }
  }

  return <main id="game" className={lobby ? "game-shell is-lobby" : "game-shell is-playing"}>
    <ArcadeAtmosphere active={!lobby} />
    <div className="game-nav">
      <button className="game-wordmark" onClick={() => setLobby(true)} aria-label="Double or Drop home">double<span>or</span>drop<span className="wordmark-star" aria-hidden="true">✳</span></button>
      <div className="game-nav-right"><span className="unlimited-badge"><i /> DAILY + ON REPEAT</span><button className="help-button" onClick={() => help.current?.showModal()} aria-label="How to play">?</button></div>
    </div>

    {game?.modeNotice && <p className="mode-notice" role="status">{game.modeNotice}</p>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button disabled={busy} onClick={() => void refresh(false)}>Retry</button></div>}

    {lobby ? <>
      <section className="hero">
        <div className="hero-copy"><h1>Know a little.<br /><em>Risk a little.</em></h1><p>Two songs. One choice. Back your music instincts,<br className="desktop-break" /> build a streak, then bank it — or double down.</p><div className="hero-tags"><span>◷ 20s per pick</span><span>✦ A fresh daily mix</span><span>∞ Unlimited runs</span></div></div>
        <div className="hero-art" aria-hidden="true"><DropBuddies /></div>
      </section>

      <div className="play-modes" role="group" aria-label="Play mode">
        <button className={`play-mode mode-daily ${mode==="daily"?"selected":""}`} aria-pressed={mode==="daily"} disabled={busy||loadingCollection} onClick={()=>changeMode("daily")}><span className="mode-glyph" aria-hidden="true">✦</span><span><strong>Daily Drop</strong><span>10 picks · 3 lives · one attempt</span></span><b aria-hidden="true">↗</b></button>
        <button className={`play-mode ${mode==="unlimited"?"selected":""}`} aria-pressed={mode==="unlimited"} disabled={busy||loadingCollection} onClick={()=>changeMode("unlimited")}><span className="mode-glyph" aria-hidden="true">∞</span><span><strong>Unlimited</strong><span>Unlimited runs · make it personal</span></span><b aria-hidden="true">↗</b></button>
      </div>
      <section className="setup-panel" aria-labelledby="setup-title">
        <div className="setup-heading"><div><h2 id="setup-title">Find your groove<span>.</span></h2></div></div>
        {incomplete && mode!=="daily" && <div className="run-reset-notice" role="status"><span aria-hidden="true">↻</span><div><strong>Ready for a fresh start.</strong><p>Your previous run was saved as incomplete. {game.banked > 0 ? `${number(game.banked)} banked points stay in your stats.` : "Any unbanked pot was discarded."}</p><GoalOutcome game={game} />{signedIn && !statsSynced && <p>Account stats are waiting to sync. <button className="text-button" disabled={busy} onClick={() => void refresh(false)}>Retry sync ↻</button></p>}</div><a href={withBasePath("/stats")}>My stats ↗</a></div>}
        {active ? <div className="resume-panel"><div><h3>{number(game.banked)} banked <span>·</span> {game.lives} {game.lives === 1 ? "life" : "lives"} left</h3><p>Your choices and banked points are saved. An active pick’s timer keeps running.</p></div><div className="resume-controls"><button className="button primary md-arcade-button" onClick={() => setLobby(false)} disabled={busy}>Resume run <span>↗</span></button><button className="button secondary discard-run" disabled={busy} onClick={() => void act("discard")}>{mode==="daily"?"End today’s attempt":"Discard & start fresh"} <span aria-hidden="true">↻</span></button><small>{mode==="daily"?"This uses today’s attempt. Banked points stay; the unbanked pot is lost.":"Marks this run incomplete. Banked points stay; the unbanked pot is lost."}</small></div></div> : mode==="daily" ? <div className="daily-invitation">
          <div className="daily-stamp" aria-hidden="true"><strong>10</strong><span>pairs</span><i>♪</i></div>
          <div className="daily-invitation-copy"><span className="eyebrow">{daily?.date||"TODAY"} · RESETS 00:00 UTC</span><h3>{game?.mode==="daily"&&game.phase==="complete"?"Your daily is on the record.":"One little mix. Big main-character energy."}</h3>
          <p>{game?.mode==="daily"&&game.phase==="complete"?`${number(game.banked)} points banked · ${game.correct}/${game.answered} correct. ${incomplete?"Saved as incomplete.":"Nicely played."} Your next daily arrives at midnight UTC.`:"Everyone gets the same ten pairs. Bank smart, risk a little, and see how far your instincts take you."}</p>
          <div className="daily-rules"><span>◷ 20s per pick</span><span>♥ ♥ ♥</span><span>✦ Final pot auto-banks</span></div>
          {game?.mode==="daily"&&game.phase==="complete"?<div className="daily-actions"><button className="button primary md-arcade-button" onClick={()=>setLobby(false)}>View today’s result ↗</button><button className="text-button" disabled={busy} onClick={()=>changeMode("unlimited")}>Keep going in Unlimited →</button></div>:<button className="button primary md-arcade-button" disabled={busy||!catalog} onClick={()=>void act("create")}>{busy?"Preparing today’s mix…":"Drop into today’s mix"}<span aria-hidden="true">↗</span></button>}
          <small className="daily-fine">One attempt per browser. Ending early uses it too. Finish before midnight UTC; your unlimited run stays separate.</small></div>
        </div> : <>
          <div className="setup-grid"><div className="setup-field"><label htmlFor="theme">01 <span>Pick a collection</span></label><CollectionPicker themes={catalog?.themes || []} selected={selectedTheme} disabled={busy || loadingCollection || !catalog} onSelect={changeTheme} /><div className="collection-divider"><span>or make it personal</span></div><ArtistCollectionSearch disabled={busy} onLoadingChange={setLoadingCollection} onSelect={changeTheme} selected={theme?.id.startsWith("artist:") ? theme.label : null} /></div>
          <div className="setup-field"><span className="field-label">02 <span>Choose your challenge</span></span><div className="metric-options" role="group" aria-label="Comparison type">{(["mixed", "streams", "duration"] as MetricFilter[]).map(item => <button key={item} className={metric === item ? "selected" : ""} aria-pressed={metric === item} disabled={busy || loadingCollection || (item !== "mixed" && !available.includes(item))} onClick={() => setMetric(item)}><span aria-hidden="true">{metricIcons[item]}</span>{metricNames[item]}</button>)}</div><p className="field-hint">{metric === "mixed" ? "A fresh mix of streams and runtime." : metric === "streams" ? "Which song has more recorded streams?" : metric === "duration" ? "Which recording runs longer?" : "Which song has the higher catalogued BPM?"}</p></div></div>
          <BankTargetPicker value={bankTarget} onChange={value => { setBankTarget(value); createId.current = null; }} disabled={busy || loadingCollection} best={personalBest} /><div className="setup-bottom"><p><span aria-hidden="true">✳</span> Twenty seconds. Two tracks. Trust your instincts.</p><button className="button primary md-arcade-button start-button" disabled={busy || loadingCollection || !catalog} onClick={() => void act("create")}>{loadingCollection ? "Loading artist…" : busy ? "Getting ready…" : "Let’s play"}<span aria-hidden="true">↗</span></button></div>
        </>}
      </section>
      <section className="rule-strip" aria-label="The basics"><div><span className="rule-number">01</span><h3>Make your pick</h3><p>Choose in 20 seconds. Closer comparisons raise the stakes. Time runs out? You lose a life.</p></div><div><span className="rule-number">02</span><h3>Feel the double</h3><p>Get it right: 100 points. Risk again for 200, then 400, up to 3,200.</p></div><div><span className="rule-number">03</span><h3>Know when to bank</h3><p>A miss costs a life and your pot. Banked points? Yours to keep.</p></div></section>
      <details className="collection-note"><summary>Good to know about the numbers <span>+</span></summary><p>Streams are dated snapshots, not live counters. Runtime is for the specific recording. Every answer shows its source after you make your pick. Missing or tied values are kept out of comparisons.</p><p>Start with the full collection or narrow it to a genre or an artist with enough comparable tracks. Your run stays saved, but an active pick’s 20-second clock keeps running when you leave.</p></details>
    </> : game ? <>
      <div className="run-topline"><span className="eyebrow"><span className="live-pick-light" aria-hidden="true" />{showFinalReveal ? "THE FINAL PICK" : game.phase === "complete" ? "THAT’S A WRAP" : `PICK ${String(game.round + 1).padStart(2, "0")}`} <span className="topline-separator">/</span> {game.mode==="daily"?`DAILY · ${game.round+1}/10`:metricNames[game.metricFilter].toUpperCase()}</span><button className="text-button" onClick={() => setLobby(true)}>Game home <span aria-hidden="true">↗</span></button></div>
      {game.mode==="daily"&&<DailyProgress game={game}/>}
      <section className={`scoreboard ${feedback?.kind === "bad" ? "life-lost" : ""}`} aria-label="Your run"><div className="score-cell banked"><span>Banked</span><strong key={`bank-${game.banked}`} title={`${number(game.banked)} points`}>{compact(game.banked)}<small>pts</small></strong></div><div className="score-cell pot"><span>At risk</span><strong key={`pot-${game.pot}`}>{number(game.pot)}<small>pts</small></strong></div><div className="score-cell lives" key={`lives-${feedback?.revision ?? "initial"}`}><span>Lives</span><div aria-label={`${game.lives} of 3 lives remaining`}>{[0, 1, 2].map(i => <span key={i} className={i < game.lives ? "heart alive" : "heart"} aria-hidden="true">♥</span>)}</div></div></section>

      <RunGoalRibbon game={game} milestone={lobby ? null : milestone} />{game.phase === "complete" && !showFinalReveal ? <section className="result-panel" aria-labelledby="result-title"><div className="result-sticker" aria-hidden="true">{incomplete ? "↻" : game.banked > 0 ? "✳" : "↻"}</div><h1 id="result-title">{incomplete ? "Run left incomplete." : game.mode==="daily" ? "Today’s mix. Your mark." : game.banked > 0 ? "That’s in the bank." : "Another spin?"}</h1><div className={`result-total ${game.banked >= 1_000_000 ? "long-total" : ""}`}>{number(game.banked)}<span>points kept</span></div><div className="result-metrics"><div><strong>{game.correct}<small>/{game.answered}</small></strong><span>correct picks</span></div><div><strong>{game.bestStreak}</strong><span>best streak</span></div><div><strong>{game.answered ? Math.round(game.correct / game.answered * 100) : 0}<small>%</small></strong><span>accuracy</span></div></div><div className="result-actions"><button className="button primary md-arcade-button" disabled={busy} onClick={()=>game.mode==="daily"?changeMode("unlimited"):freshSetup()}>{game.mode==="daily"?"Keep playing · Unlimited ↗":"Play another run ↗"}</button><button className="button secondary" onClick={() => void share()}>{shareLabel}</button></div><p className="save-note" role="status">{incomplete ? signedIn ? statsSynced ? "Saved as an incomplete run in your account stats." : "Incomplete run saved here. Account stats are waiting to sync." : guestOnly ? "Saved as an incomplete run for this browser." : "Saved as an incomplete run for this browser. Sign in to keep it with your account." : game.answered === 0 ? "No picks made, so this run won’t count toward your stats." : signedIn ? statsSynced ? "Your finished run is saved to your Musical Daily stats." : "Your run is saved here. Account stats are waiting to sync." : guestOnly ? "Your run is saved for this browser. Thanks for playing." : "Your run is saved in this browser. Sign in to keep finished runs with your account."}</p>{signedIn && !statsSynced && <button className="text-button" disabled={busy} onClick={() => void refresh(false)}>Retry stats sync ↻</button>}<a className="result-stats-link" href={withBasePath("/stats")}>Your Double or Drop stats ↗</a></section> : <>
        <section className="question-heading" aria-live="polite"><div className="question-meta"><span className="metric-badge">{metricIcons[game.pair.metric]} {game.pair.label}</span>{game.phase === "guess" && <div className={`pick-clock ${urgent ? "urgent" : ""} ${expired ? "expired" : ""}`} role="timer" aria-live="off" aria-label={`${Math.ceil(remaining)} seconds remaining`}><span aria-hidden="true">◷</span><strong>{String(Math.ceil(remaining)).padStart(2, "0")}</strong><small>SEC LEFT</small><i style={{ width: `${Math.min(100, remaining / 20 * 100)}%` }} /></div>}</div><h1>{game.pair.question}</h1><p>{game.phase === "guess" ? game.pot > 0 ? `You’re risking ${number(game.pot)} for ${number(game.nextReward)} points. Trust your pick.` : "One good pick starts a 100-point pot. Which one feels right?" : game.reveal?.correct ? "Good instincts. Now, how brave are you feeling?" : showFinalReveal ? game.endReason==="daily-complete"?"The last track on today’s ticket. Here’s how the two compare.":"That was your last life. Here’s how the two songs compare." : "A little record scratch. Your banked points are safe."}</p></section>
        <div className={`comparison ${game.phase === "guess" ? "is-guessing" : "is-revealed"}`} aria-busy={busy}><SongCard track={game.pair.left} side="left" index={1} game={game} busy={busy || expired} preview={preview} onPick={side => void act("guess", side)} /><div className="versus" aria-hidden="true">or</div><SongCard track={game.pair.right} side="right" index={2} game={game} busy={busy || expired} preview={preview} onPick={side => void act("guess", side)} /></div>
        {game.phase === "guess" ? <div className="guess-bottom"><span><kbd>1</kbd> or <kbd>2</kbd> to pick <span className="desktop-keyboard">· Mouse works too</span></span><span>{expired ? "Time’s up. Saving this pick…" : busy ? "Saving your pick…" : "Your clock keeps running if you leave the page."}</span>{game.pot === 0 && <button className="text-button" disabled={busy} onClick={() => void act("cashout")}>Finish run ↗</button>}</div> : showFinalReveal ? <section className="decision-panel missed final-loss-panel" role="status"><div className="decision-copy"><span className="decision-icon" aria-hidden="true">↺</span><div><span className="eyebrow">{game.endReason==="daily-complete"?"TEN PICKS · DAILY MIX COMPLETE":game.reveal?.timedOut ? "TIME’S UP · LAST LIFE" : "LAST LIFE · ONE TO REMEMBER"}</span><h2>{game.endReason==="daily-complete"?game.reveal?.correct?"A lovely final note.":"Your daily is on the record.":game.reveal?.timedOut ? "The clock got this one." : "Not this record. Now you know."}</h2><p>{game.endReason==="daily-complete"?"Any surviving pot is safely banked. Take a moment to see the answer.":"Your banked points are safe. Take a moment to see the answer."}</p></div></div><div className="final-reveal-wait"><span aria-hidden="true">● ● ●</span> Your results are coming up…</div></section> : <div key={`decision-${feedback?.revision ?? game.revision}`} className={`decision-panel ${game.phase === "miss" ? "missed" : ""} ${feedback?.kind === "good" ? "celebrate" : ""}`} aria-live="polite"><div className="decision-copy"><span className="decision-icon" aria-hidden="true">{game.phase === "miss" ? "↺" : "✳"}</span><div><span className="eyebrow">{game.phase === "miss" ? game.reveal?.timedOut ? "TIME’S UP" : "MISSED THIS ONE" : game.canRisk ? "YOUR CALL" : "TOP OF THE LADDER"}</span><h2>{game.phase === "miss" ? `${game.lives} ${game.lives === 1 ? "life" : "lives"} left. Keep your groove.` : game.canRisk ? `Bank ${number(game.pot)} or go for ${number(game.nextReward)}?` : "3,200. That deserves a bank."}</h2><p>{game.phase === "miss" ? "Your pot is gone. Your bank stays untouched." : game.canRisk ? "Choose before you see the next pair. A miss drops this pot." : "Bank your points, reset to 100, and keep playing."}</p></div></div><div className="decision-actions">{game.phase === "miss" ? <><button className="button primary md-arcade-button" disabled={busy} onClick={() => void act("next")}>Next pair <span>↗</span></button><button className="text-button" disabled={busy} onClick={() => void act("cashout")}>Finish run</button></> : <><button className="button bank-button" disabled={busy} onClick={() => void act("bank")}>Bank & keep playing <kbd>B</kbd></button>{game.canRisk && <button className="button primary md-arcade-button risk-button" disabled={busy} onClick={() => void act("risk")}>Risk for {number(game.nextReward)} <kbd>R</kbd></button>}<button className="text-button cashout" disabled={busy} onClick={() => void act("cashout")}>Bank & finish run ↗</button></>}</div></div>}
        {game.reveal && <p className="reveal-explanation">{game.reveal.explanation}</p>}
        <div className="ladder" aria-label={`Doubling ladder: step ${game.ladder} of ${game.maxLadder}`}><span>THE DOUBLE</span>{[100, 200, 400, 800, 1600, 3200].map((points, index) => <span key={points} className={`ladder-step ${game.ladder > index ? "reached" : ""} ${game.ladder === index + 1 ? "current" : ""}`}>{number(points)}{index < 5 && <i aria-hidden="true">→</i>}</span>)}<span className="ladder-end">BANK ↙</span></div>
      </>}
      {game.results.length > 0 && <details className="run-history"><summary>Your last {game.results.length} {game.results.length === 1 ? "pick" : "picks"}<span>+</span></summary><ol>{game.results.slice().reverse().map(result => <li key={result.round}><span className={result.correct ? "history-correct" : "history-miss"}>{result.correct ? "✓" : "×"}</span><div><strong>{result.leftTitle} <span>vs.</span> {result.rightTitle}</strong><small>{metricNames[result.metric]} · {result.left.formatted} / {result.right.formatted}</small></div><span className="history-result">{result.correct ? `${number(result.earned)} pot` : result.timedOut ? "Time’s up" : "Pot dropped"}</span></li>)}</ol></details>}
    </> : <div className="loading-screen"><span className="loading-record" /><p>{busy ? "Getting the records ready…" : "Ready for a fresh spin."}</p><button className="text-button" onClick={() => setLobby(true)}>Back to game home</button></div>}

    <audio ref={preview.audio} preload="none" aria-hidden="true" />
    <dialog ref={help} className="help-dialog"><button className="dialog-close" onClick={() => help.current?.close()} aria-label="Close instructions">×</button><h2>Double or Drop<span>✳</span></h2><p>You have 20 seconds to pick the song that answers the question. Get it right and your pot starts at <strong>100 points</strong>.</p><ol><li><strong>Risk it.</strong> Another correct pick doubles your pot: 100 → 200 → 400 → 800 → 1,600 → 3,200.</li><li><strong>Bank it.</strong> Protect your pot, then keep playing from 100. At 3,200 you must bank before continuing.</li><li><strong>Miss it.</strong> A wrong answer or timeout costs one life and your current pot. Banked points stay safe. Three misses end the run.</li></ol><p><strong>The daily drop.</strong> Ten shared pairs, one attempt per browser each UTC day. Your last surviving pot automatically banks after pick ten. Three misses end it sooner. Ending early uses your attempt too. Finish before midnight UTC; your unlimited run stays independent.</p><p>Make the bank-or-risk decision before seeing the next pair. You can bank and finish after any correct answer, or finish after a miss.</p><p><strong>Make it yours.</strong> Set an optional bank goal before you start. Only safely banked points fill the meter; reaching it never ends a run. Your personal best comes from finalized saved runs, including protected banks from incomplete runs. Correct streaks continue across banks and reset after a miss.</p><p>Your progress saves automatically. Use the game logo to return home. An active pick’s clock keeps running when you leave the page. Banking decisions have no timer. Use Discard & start fresh on the home screen to close a run as incomplete and choose a new collection. Banked points stay; an unbanked pot is lost. No daily limit.</p><button className="button primary md-arcade-button" onClick={() => help.current?.close()}>Got it. Let’s spin ↗</button></dialog>
  </main>;
}

function DailyProgress({game}:{game:PublicGame}){return <div className="daily-progress" aria-label={`Daily mix: ${game.answered} of 10 picks answered`}><span>THE TEN-TRACK TICKET <b>{game.dailyDate}</b></span><ol>{Array.from({length:10},(_,i)=>{const result=game.results.find(r=>r.round===i);return <li key={i} className={result?result.correct?"hit":"missed":game.round===i&&game.phase!=="complete"?"current":""} aria-label={`Pick ${i+1}: ${result?result.correct?"correct":"missed":game.round===i&&game.phase!=="complete"?"current":"unplayed"}`}>{result?result.correct?"♪":"×":String(i+1).padStart(2,"0")}</li>})}</ol></div>;}

function ArcadeAtmosphere({ active }: { active: boolean }) {
  return <div className={`arcade-atmosphere ${active ? "in-session" : "in-lobby"}`} aria-hidden="true">
    <div className="arcade-halo halo-left" /><div className="arcade-halo halo-right" />
    <div className="arcade-rail rail-left"><span className="rail-record"><i>2×</i></span><span className="rail-spark">✳</span><span className="rail-ticket">BACK<br />YOURSELF.<i>↗</i></span></div>
    <div className="arcade-rail rail-right"><span className="rail-ticket">TRUST<br />THE GUT.<i>✦</i></span><span className="rail-record"><i>MD</i></span><span className="rail-spark">✳</span><span className="drop-pixel-note" /></div>
    <div className="arcade-bottom-wave">{Array.from({ length: 21 }, (_, index) => <i key={index} style={{ height: `${8 + ((index * 17) % 31)}px`, animationDelay: `${index * -.13}s` }} />)}</div>
  </div>;
}

function SongCard({ track, side, index, game, busy, onPick, preview }: { track: PublicTrack; side: Side; index: number; game: PublicGame; busy: boolean; onPick: (side: Side) => void; preview: ReturnType<typeof useSongPreview> }) {
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  const revealed = game.phase !== "guess";
  const won = revealed && game.reveal?.winner === side;
  const selected = revealed && game.reveal?.selected === side;
  const value = game.reveal?.[side];
  const initials = track.artist.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("");
  return <article className={`song-card ${won ? "winning-card" : ""} ${revealed && !won ? "losing-card" : ""}`}>
    <button className="song-pick" disabled={busy || revealed} onClick={() => onPick(side)} aria-label={`Choose ${track.title} by ${track.artist}`}>
      <div className="artwork"><span className="sleeve-record" aria-hidden="true"><i>{index === 1 ? "A" : "B"}</i></span><div className="artwork-fallback" aria-hidden="true"><div className="fallback-vinyl"><span>{initials}</span></div></div>{track.artwork && failedArtwork !== track.artwork && <img src={withBasePath(track.artwork)} alt="" width={480} height={480} referrerPolicy="no-referrer" onError={() => setFailedArtwork(track.artwork)} />}<span className="pick-key">{revealed ? won ? "✓" : "×" : index}</span>{selected && <span className="your-pick">YOUR PICK</span>}</div>
      <div className="song-info"><p>{track.artist}</p><h2>{track.title}</h2>{revealed && value ? <div className={`revealed-value value-${game.pair.metric}`}><strong>{value.formatted}</strong><span>{won ? "THE WINNING RECORD" : "CLOSE, BUT NOT THIS ONE"}</span></div> : <div className="pick-prompt"><span>Back this track</span><span aria-hidden="true">↗</span></div>}</div>
    </button>
    {game.pair.metric === "tempo" && game.phase !== "complete" && <div className="track-listen"><button disabled={!track.previewUrl || (busy && preview.playing !== track.id)} onClick={() => void preview.play(track)} aria-label={`${preview.playing === track.id ? "Stop" : "Play"} preview of ${track.title}`}>{preview.playing === track.id ? "■ Stop preview" : preview.loading === track.id ? "Cancel loading…" : track.previewUrl ? "▶ 10s preview" : "Preview unavailable"}</button>{revealed && track.previewSourceUrl && <a href={track.previewSourceUrl} target="_blank" rel="noopener noreferrer">Full song ↗</a>}{preview.error?.id === track.id && <small role="status">{preview.error.message}</small>}</div>}
    {revealed && value && <Source value={value} metric={game.pair.metric} />}
  </article>;
}

function Source({ value, metric }: { value: ValueReveal; metric: Metric }) {
  return <div className="value-source"><a href={value.source} target="_blank" rel="noopener noreferrer">{metric === "streams" ? "Stream snapshot" : metric === "tempo" ? "Catalogued tempo" : "Recording details"} ↗</a>{value.asOf && <time dateTime={value.asOf}>{value.asOf}</time>}{metric === "tempo" && <span>Estimated BPM</span>}</div>;
}
