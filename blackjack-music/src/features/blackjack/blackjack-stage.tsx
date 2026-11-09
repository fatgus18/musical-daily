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
      <svg viewBox="0 0 24 24" fill="none" shapeRendering="crispEdges">
        <path d="M1 7V1h6M17 1h6v6M23 17v6h-6M7 23H1v-6" stroke="currentColor" strokeOpacity=".6" />
        <path d="M11 4h2v2h2v2h2v2h2v6h-2v2h-4v-2h-2v2H7v-2H5v-6h2V8h2V6h2Zm0 14h2v2h2v1H9v-1h2Z" fill="currentColor" />
      </svg>
    </div>
  );
}
