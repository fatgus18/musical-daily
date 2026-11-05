"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AccountButton, AccountSignIn, useAccount, type AccountUser } from "./account-client";
import { MusicalDailyBrand } from "./musical-daily-brand";
import type { AccountStats, GameStats, GameId } from "@musical-daily/accounts";

interface StatsResponse { user: AccountUser; games: AccountStats["games"] }
type GameKey = keyof StatsResponse["games"];
const details = {
  blackjack: { name: "Blackjack Music", label: "A LITTLE RISK. A LOT OF INSTINCT.", empty: "Every great hand starts with a first pick.", play: "Deal me in", noun: "hand" },
  tempo: { name: "Tempo Trap", label: "YOUR INNER METRONOME.", empty: "Your rhythm is waiting to make an entrance.", play: "Find my rhythm", noun: "mix" },
  encore: { name: "Encore", label: "FOR THE VERY BIG FANS.", empty: "A favorite artist. Ten songs. Your moment.", play: "Find my artist", noun: "mix" },
  "double-drop": { name: "Double or Drop", label: "GOOD INSTINCTS. GREAT TIMING.", empty: "Your next good hunch could be the one.", play: "Make my call", noun: "run" },
};
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const incompleteReasons = { discarded: "Ended early by you", replaced: "Replaced with a new run", expired: "The saved run expired", "account-merge": "Another saved run was kept when you signed in" };
function recentAccuracy(entry: GameStats["recent"][number]) {
  const denominator = entry.status === "incomplete" ? entry.rounds ?? entry.maxScore : entry.maxScore;
  return { denominator, correct: entry.status === "incomplete" ? entry.correct ?? entry.score : entry.score };
}
function recentDescription(entry: GameStats["recent"][number], game: GameId) {
  const { denominator, correct } = recentAccuracy(entry);
  const result = denominator ? `${number(correct)} out of ${number(denominator)}${entry.status === "incomplete" ? " answered" : ""}` : "No answers submitted";
  return `${entry.status === "incomplete" ? "Incomplete" : "Completed"}: ${game === "double-drop" ? `${number(entry.bankedPoints || 0)} points banked; ` : ""}${result}`;
}

function RecordFriend() {
  return <svg className="md-stats-record-friend" viewBox="0 0 220 180" fill="none" aria-hidden="true">
    <path className="md-friend-note" d="M188 43V21l14-4v20m-14-8 14-4" stroke="#ff9c90" strokeWidth="3" strokeLinecap="round"/><ellipse cx="183" cy="44" rx="6" ry="4" transform="rotate(-20 183 44)" fill="#ff9c90"/><ellipse cx="197" cy="38" rx="6" ry="4" transform="rotate(-20 197 38)" fill="#ff9c90"/>
    <path d="m29 55 3-8 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#b4dccb"/><path d="m180 138 2-5 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#c4f58a"/>
    <ellipse cx="110" cy="162" rx="58" ry="7" fill="#000" opacity=".2"/><path d="m84 141-7 13-10 2m63-15 7 13 10 2" stroke="#bcc6af" strokeWidth="4" strokeLinecap="round"/>
    <g className="md-friend-record"><circle cx="110" cy="89" r="65" fill="#212a20" stroke="#667758"/><circle cx="110" cy="89" r="56" stroke="#384633"/><circle cx="110" cy="89" r="47" stroke="#384633"/><circle cx="110" cy="89" r="38" stroke="#384633"/><circle cx="110" cy="89" r="30" fill="#c4f58a"/><path d="M97 85v5m26-5v5" stroke="#293a1d" strokeWidth="3" strokeLinecap="round"/><path d="M103 98q7 8 14 0" stroke="#293a1d" strokeWidth="2.5" strokeLinecap="round"/><ellipse cx="93" cy="96" rx="4" ry="2" fill="#9ebd71"/><ellipse cx="127" cy="96" rx="4" ry="2" fill="#9ebd71"/></g>
    <path d="M46 95q-12 1-15-10m143 10q12 1 17-11" stroke="#bcc6af" strokeWidth="3" strokeLinecap="round"/>
  </svg>;
}

function GameSticker({ game }: { game: GameKey }) {
  return <div className={`md-stats-sticker md-sticker-${game}`} aria-hidden="true">{game === "blackjack" ? <><span className="md-sticker-suit">♠</span><small>GOOD HANDS CLUB</small></> : game === "tempo" ? <><span className="md-sticker-wave"><i/><i/><i/><i/><i/><i/><i/></span><small>ON YOUR BEAT</small></> : game === "double-drop" ? <><span className="md-sticker-double">2×</span><small>TRUST YOUR GUT</small></> : <><span className="md-sticker-disc"><i/></span><small>NUMBER ONE FAN</small></>}</div>;
}

function StatValue({ value, label, suffix, title, loading }: { value: string; label: string; suffix?: string; title?: string; loading: boolean }) {
  return <div className="md-stats-metric"><dt>{label}</dt><dd title={loading ? undefined : title} className={loading ? "md-stats-value-loading" : ""}>{loading ? <><span aria-hidden="true">···</span><span className="md-stats-sr-only">Loading</span></> : <>{value}{suffix && value !== "—" && <small>{suffix}</small>}</>}</dd></div>;
}

function StatsCard({ game, stats, href, signedIn, loading }: { game: GameKey; stats?: GameStats; href: string; signedIn: boolean; loading: boolean }) {
  const detail = details[game];
  const played = !!stats && stats.played > 0;
  const finished = !!stats && stats.completed > 0;
  const answered = !!stats && stats.totalRounds > 0;
  const tracksIncomplete = game === "encore" || game === "double-drop";
  const count = (value: number | undefined) => value === undefined ? "—" : number(value);
  const points = (value: number | undefined) => value === undefined ? "—" : value >= 1000000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value) : number(value);
  const metrics = game === "blackjack" ? [
    { label: "Hands finished", value: count(stats?.completed) }, { label: "Safe hands", value: count(stats?.wins) },
    { label: "Best closeness", value: finished ? count(stats?.bestScore) : "—", suffix: "%" }, { label: "Average closeness", value: finished ? count(stats?.averagePercent) : "—", suffix: "%" },
  ] : game === "tempo" ? [
    { label: "Mixes finished", value: count(stats?.completed) }, { label: "Personal best", value: finished ? count(stats?.bestScore) : "—", suffix: " / 5,000" },
    { label: "Average score", value: finished ? count(stats?.averageScore) : "—" }, { label: "Daily streak", value: count(stats?.currentStreak), suffix: stats?.currentStreak === 1 ? " day" : " days" },
  ] : game === "double-drop" ? [
    { label: "Runs finished", value: count(stats?.completed) }, { label: "Incomplete runs", value: stats ? count(stats.incomplete ?? 0) : "—" },
    { label: "Banked points", value: points(stats?.totalBanked), title: stats ? `${count(stats.totalBanked)} protected points, including incomplete runs` : undefined }, { label: "Best bank", value: played ? points(stats?.bestBanked) : "—", title: played ? `${count(stats?.bestBanked)} points protected in one run` : undefined },
    { label: "Accuracy", value: answered ? count(stats?.averagePercent) : "—", suffix: "%" }, { label: "Finished with points", value: count(stats?.wins), title: "Completed runs with points banked" },
  ] : [
    { label: "Mixes finished", value: count(stats?.completed) }, { label: "Incomplete mixes", value: stats ? count(stats.incomplete ?? 0) : "—" },
    { label: "Songs recognized", value: count(stats?.totalCorrect) }, { label: "Songs answered", value: count(stats?.totalRounds) },
    { label: "Average accuracy", value: answered ? count(stats?.averagePercent) : "—", suffix: "%" }, { label: "Perfect mixes", value: count(stats?.wins) },
  ];
  const recent = (stats?.recent ?? []).slice(0, 7).reverse();
  const lastArtist = game === "encore" ? stats?.recent.find(item => item.artist)?.artist?.name : null;
  return <article className={`md-stats-game-card md-stats-${game}`} aria-labelledby={`md-stats-title-${game}`}>
    <div className="md-stats-card-heading"><GameSticker game={game}/><div className="md-stats-game-title"><span className="md-stats-eyebrow">{detail.label}</span><h2 id={`md-stats-title-${game}`}>{detail.name}<span>.</span></h2><p>{played ? game === "blackjack" ? "Knowing when to stop is a talent, too." : game === "tempo" ? "Turns out, you do have a pretty good ear." : game === "double-drop" ? "A little nerve. A lovely little nest egg." : "Some call it an obsession. We call it good taste." : detail.empty}</p></div><a className="md-stats-play" href={href}>{detail.play} <span aria-hidden="true">↗</span></a></div>
    <dl className={`md-stats-metrics${tracksIncomplete ? " md-stats-metrics-expanded" : ""}`}>{metrics.map(metric => <StatValue key={metric.label} {...metric} loading={loading}/>)}</dl>
    {tracksIncomplete && played && <p className="md-stats-accounting-note">Incomplete {game === "encore" ? "mixes" : "runs"} keep their answered {game === "encore" ? "songs" : "picks"} in your accuracy.{game === "double-drop" ? " Banked points stay protected." : " Unplayed songs don't count as misses."}</p>}
    <div className="md-stats-card-foot">
      {played ? <>
        <span className="md-stats-little-note"><span aria-hidden="true">✳</span> {game === "encore" ? lastArtist ? <>Last on repeat: <b>{lastArtist}</b></> : "Your fan era looks good on you." : game === "double-drop" ? <><b>{number(stats?.played ?? 0)}</b> saved runs. Plenty more where those came from.</> : <>Best daily streak: <b>{number(stats?.bestStreak ?? 0)} {(stats?.bestStreak ?? 0) === 1 ? "day" : "days"}</b></>}</span>
        <div className="md-stats-recent"><span>LAST {recent.length} {recent.length === 1 ? detail.noun.toUpperCase() : detail.noun === "mix" ? "MIXES" : `${detail.noun.toUpperCase()}S`}</span><div className="md-stats-mini-bars" role="img" aria-label={`Recent ${game === "double-drop" ? "accuracy" : "scores"}, oldest to newest: ${recent.map(entry => recentDescription(entry, game)).join(", ")}`}>{recent.map(entry => {
          const { denominator, correct } = recentAccuracy(entry);
          return <i key={entry.eventId} className={entry.status === "incomplete" ? "md-stats-bar-incomplete" : undefined} style={{ height: `${Math.max(3, Math.min(100, denominator ? correct / denominator * 100 : 0))}%` }} title={`${entry.date}: ${recentDescription(entry, game)}`}/>;
        })}</div></div>
      </> : <span className="md-stats-little-note"><span aria-hidden="true">♡</span> {loading ? "Finding your highlights…" : !signedIn ? "Sign in to give your scores a home." : stats ? "Your first score will look lovely here." : "Your scores will appear when we reconnect."}</span>}
    </div>
  </article>;
}


export interface MusicStatsProps {
  game?: GameId;
  hubUrl: string;
  gameUrls?: Partial<Record<GameId, string>>;
}
const gameOrder: GameId[] = ["blackjack", "tempo", "encore", "double-drop"];

function gameHref(url: string, signedIn: boolean) {
  return signedIn ? `${url.replace(/\/$/, "")}/api/account/login?returnTo=%2F` : url;
}

function RecentResults({ game, stats }: { game: GameId; stats?: GameStats }) {
  if (!stats?.recent.length) return null;
  return <section className="md-stats-history" aria-labelledby="recent-results">
    <div className="md-stats-history-heading"><div><span className="md-stats-eyebrow">FRESH OFF THE RECORD</span><h2 id="recent-results">Your recent plays<span>.</span></h2></div><span>Latest {stats.recent.length}</span></div>
    <ol>{stats.recent.map(entry => {
      const incomplete = entry.status === "incomplete";
      const { denominator } = recentAccuracy(entry);
      return <li key={entry.eventId}>
        <span className="md-stats-history-icon" aria-hidden="true">{incomplete ? "↺" : game === "double-drop" ? "↗" : game === "blackjack" ? "♠" : "♪"}</span>
        <div className="md-stats-history-label"><div className="md-stats-history-date"><time dateTime={entry.date}>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(entry.date))}</time>{(game === "encore" || game === "double-drop") && <span className={`md-stats-result-status${incomplete ? " md-stats-result-incomplete" : ""}`} title={entry.incompleteReason ? incompleteReasons[entry.incompleteReason] : undefined}>{incomplete ? "Incomplete" : "Completed"}</span>}</div><span>{game === "encore" ? entry.artist?.name || "An Encore mix" : game === "double-drop" ? denominator ? `${number(entry.score)} of ${number(denominator)} picks correct` : "No picks answered" : game === "blackjack" ? entry.won ? "A safe hand" : "A hand to learn from" : "A little rhythm check"}</span>{incomplete && entry.incompleteReason && <span className="md-stats-history-reason">{incompleteReasons[entry.incompleteReason]}</span>}</div>
        <strong>{game === "double-drop" ? <>{number(entry.bankedPoints ?? 0)}<small> banked</small></> : game === "blackjack" ? <>{number(entry.score)}<small>% close</small></> : incomplete ? denominator ? <>{number(entry.score)}<small> / {number(denominator)} answered</small></> : <><span aria-hidden="true">—</span><small>No answers</small></> : <>{number(entry.score)}<small> / {number(entry.maxScore)}</small></>}</strong>
      </li>;
    })}</ol>
  </section>;
}

export default function MusicStats(props: MusicStatsProps) {
  const account = useAccount();
  // Remount the resource before rendering another identity, including signing out.
  return <MusicStatsContent key={`${account.user?.id ?? "guest"}:${account.loading}:${account.error ?? ""}`} {...props} />;
}

function MusicStatsContent({ game, hubUrl, gameUrls = {} }: MusicStatsProps) {
  const { user, loading: accountLoading, error: accountError, refresh } = useAccount();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [pending, setPending] = useState(!!user);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const accountId = user?.id;
  useEffect(() => {
    if (!accountId || accountLoading || accountError) return;
    const controller = new AbortController();
    fetch("/api/account/stats", { cache: "no-store", credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (response.status === 401) { await refresh(); throw new Error("Please sign in again to see your stats."); }
      if (!response.ok) throw new Error("Your stats could not be loaded. Your saved scores are still safe.");
      const result: StatsResponse = await response.json();
      if (result.user?.id !== accountId) throw new Error("Your account changed. Refresh to see the right scores.");
      if (!result.games || gameOrder.some(id => !result.games[id])) throw new Error("Your stats are temporarily unavailable. Please try again.");
      if (!controller.signal.aborted) { setData(result); setFailure(null); }
    }).catch(reason => { if (!controller.signal.aborted) setFailure(reason instanceof Error ? reason.message : "We could not load your stats."); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [accountId, accountLoading, accountError, retry, refresh]);
  useEffect(() => {
    const reload = () => { if (document.visibilityState === "visible") setRetry(value => value + 1); };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => { window.removeEventListener("focus", reload); document.removeEventListener("visibilitychange", reload); };
  }, []);
  const current = data?.user.id === accountId ? data : null;
  const games = game ? [game] : gameOrder;
  const total = current ? games.reduce((sum, id) => sum + current.games[id].completed, 0) : 0;
  const incompleteTotal = current ? games.reduce((sum, id) => sum + (current.games[id].incomplete ?? 0), 0) : 0;
  const loading = accountLoading || pending;
  const hub = hubUrl.replace(/\/$/, "");
  const localName = game ? details[game].name : null;
  return <div className="md-stats-shell">
    <a href="#your-stats" className="md-stats-skip">Skip to your stats</a>
    <header className="md-stats-header">
      <MusicalDailyBrand href={game ? hub : "/"} />
      <nav aria-label="Main navigation">
        <Link href="/">{game ? "← Back to game" : "All games"}</Link>
        <Link href="/stats" aria-current="page">{game ? "Game stats" : "My stats"}</Link>
        {game && <a href={`${hub}/stats`}>All game stats <span aria-hidden="true">↗</span></a>}
      </nav>
      <AccountButton statsHref="/stats" />
    </header>
    <main className="md-stats-page" id="your-stats">
      <section className="md-stats-hero"><div><div className="md-stats-edition"><span/> {game ? `${localName?.toUpperCase()} · YOUR COLLECTION` : "THE SOUND OF YOUR PROGRESS"}</div>
        <h1>{game ? <>Good plays.<br/><span>Little victories.</span></> : <>Your music.<br/><span>Your little legacy.</span></>}</h1>
        <p>{user ? <>Hey {user.name?.split(" ")[0] || "music lover"}. Every good guess deserves a little home.</> : "The lucky hands. The perfect guesses. The songs you know by heart."}<br/>{game ? `Your ${localName} scores, kept together with your Musical Daily account.` : "Four games. One very you collection."}</p>
        {current && (total > 0 || incompleteTotal > 0) && <span className="md-stats-total"><span aria-hidden="true">✦</span> {number(total)} {total === 1 ? "game" : "games"} finished.{incompleteTotal > 0 ? ` ${number(incompleteTotal)} incomplete ${incompleteTotal === 1 ? "play" : "plays"} saved, too.` : " Look at you go."}</span>}</div><RecordFriend/>
      </section>
      {!accountLoading && !user && !accountError && <section className="md-stats-sign-in" aria-label="Sign in to save your stats"><span className="md-stats-save-icon" aria-hidden="true">♡</span><div><h2>A home for your high notes.</h2><p>Sign in with Google to see your account stats here and across Musical Daily. Guest scores stay with the game in this browser.</p></div><AccountSignIn/></section>}
      {accountLoading && <p className="md-stats-status" role="status">Getting your little collection ready…</p>}
      {(accountError || failure) && <div className="md-stats-error" role="alert"><span>{accountError || failure}</span><button type="button" onClick={() => { if (accountError) void refresh(); else { setPending(true); setRetry(value => value + 1); } }}>Try again ↻</button></div>}
      <div className="md-stats-section-label"><span className="md-stats-eyebrow">{game ? "YOUR GAME, YOUR GROOVE" : "YOUR LITTLE OBSESSIONS"}</span><span className="md-stats-private"><span aria-hidden="true">♡</span> Just for you</span></div>
      <section className="md-stats-cards" aria-label="Your game statistics" aria-busy={loading}>{games.map(id => <StatsCard key={id} game={id} stats={current?.games[id]} href={game ? "/" : gameHref(gameUrls[id] || "/", !!user)} signedIn={!!user} loading={loading}/>)}</section>
      {game && <RecentResults game={game} stats={current?.games[game]} />}
      {game && <a className="md-stats-combined" href={`${hub}/stats`}><span aria-hidden="true">✳</span><span><strong>There’s more to your music.</strong><small>Find all four games together in your Musical Daily stats.</small></span><b aria-hidden="true">↗</b></a>}
      <p className="md-stats-bottom-note"><span aria-hidden="true">♪</span> Tiny victories. Excellent taste. See you for the next round.</p>
    </main>
    <footer className="md-stats-footer"><span>Made for the love of music.</span><a href={game ? hub : "/"}>Find your next favorite game ↗</a></footer>
  </div>;
}

