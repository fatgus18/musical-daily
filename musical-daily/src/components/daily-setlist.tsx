"use client";

export function DailySetlist({ href, onLaunch }: { href: string; onLaunch: () => void }) {
  return <aside className="daily-drop-ticket" aria-label="New daily challenge">
    <div className="daily-ticket-art" aria-hidden="true">
      <span className="daily-ticket-disc"><i />2×</span>
      <span className="daily-ticket-star">✦</span>
      <span className="daily-ticket-pixels">▁ ▃ ▆ ▂ ▅</span>
    </div>
    <div className="daily-ticket-copy">
      <span className="daily-ticket-kicker"><i /> NEW ON THE DAILY LINEUP</span>
      <h2>Same ten picks. <em>Different nerve.</em></h2>
      <p>Double or Drop has a daily side. One shared set, three lives, your call.</p>
    </div>
    <a href={href} onClick={onLaunch} onAuxClick={event => { if (event.button === 1) onLaunch(); }}>
      <span>Play today’s set<small>A FRESH CHALLENGE AT 00:00 UTC</small></span>
      <b aria-hidden="true">↗</b>
    </a>
  </aside>;
}
