"use client";

import { MusicalDailyBrand } from "./musical-daily-brand";
import { AccountButton } from "./account-client";
import Link from "next/link";
import { useSound } from "./sound-client";

export function HubHeader({ active, onHelp }: { active: "games" | "stats" | "studio"; onHelp?: () => void }) {
  const { setMusic } = useSound();
  return <header className={`site-header hub-header hub-header-with-studio ${active === "games" ? "hub-header-games" : active === "studio" ? "hub-header-studio" : ""}`}>
    <MusicalDailyBrand href="/" />
    <nav aria-label="Main navigation">
      <Link className={active === "games" ? "active" : ""} aria-current={active === "games" ? "page" : undefined} href="/"><span aria-hidden="true">▦</span> All games</Link>
      <Link className={`hub-studio-link ${active === "studio" ? "active" : ""}`} aria-label="Rhythm Lab" aria-current={active === "studio" ? "page" : undefined} href="/rhythm-lab" onClick={() => setMusic(false)} onAuxClick={event => { if (event.button === 1) setMusic(false); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v10h3V4m2 0v10h3V4M9 14v6m6-6v6"/></svg><span className="hub-nav-text">Rhythm Lab</span></Link>
      <Link className={active === "stats" ? "active" : ""} aria-label="My stats" aria-current={active === "stats" ? "page" : undefined} href="/stats"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 17V9m7 8V3m7 14v-6" strokeLinecap="round"/></svg><span className="hub-nav-text">My stats</span></Link>
      {onHelp && <button type="button" className="hub-help" onClick={onHelp}>How it works <span className="question-icon">?</span></button>}
    </nav>
    <AccountButton />
  </header>;
}
