/** Purely decorative stage dressing. It never covers or receives game input. */
export function BlackjackStage() {
  return (
    <div className="bj-stage" aria-hidden="true">
      <div className="bj-stage-grid" />
      <div className="bj-side bj-side-left">
        <span className="bj-side-caption">A LITTLE TASTE. A LITTLE LUCK.</span>
        <div className="bj-vinyl"><div className="bj-vinyl-label"><span>MD / 001</span><b>♠</b><small>TRUST YOUR EARS</small></div></div>
        <div className="bj-stage-ticket"><span>ADMIT ONE</span><b>GOOD<br />INSTINCTS</b><i /><small>THE LISTENING CLUB</small></div>
        <span className="bj-orbit-star">✳</span>
      </div>
      <div className="bj-side bj-side-right">
        <span className="bj-orbit-star">✧</span>
        <div className="bj-playing-card bj-playing-card-back"><span>A</span><b>♣</b></div>
        <div className="bj-playing-card bj-playing-card-front"><span>A<small>♥</small></span><b>♥</b><i>PLAY IT BY EAR</i></div>
        <div className="bj-side-wave">{Array.from({ length: 17 }, (_, index) => <i key={index} style={{ height: `${12 + ((index * 19) % 39)}px` }} />)}</div>
        <span className="bj-side-caption">THE SWEET SPOT IS CALLING.</span>
      </div>
    </div>
  );
}

export function BlackjackEmblem() {
  return (
    <div className="bj-heading-emblem" aria-hidden="true">
      <svg viewBox="0 0 120 120" fill="none">
        <circle cx="60" cy="60" r="52" stroke="currentColor" strokeDasharray="1 6" />
        <circle cx="60" cy="60" r="42" stroke="currentColor" strokeOpacity=".32" />
        <path d="M60 29C52 43 36 47 36 61c0 12 17 17 23 6-2 10-5 16-11 22h24c-6-6-9-12-11-22 6 11 23 6 23-6 0-14-16-18-24-32Z" fill="currentColor" />
        <path d="m98 12 2 8 8 2-8 2-2 8-2-8-8-2 8-2 2-8Z" fill="#fb897c" />
      </svg>
    </div>
  );
}
