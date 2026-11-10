/** Purely decorative stage dressing. It never covers or receives game input. */
export function BlackjackStage() {
  return (
    <div className="bj-stage" aria-hidden="true">
      <div className="bj-stage-grid" />
      <div className="bj-side bj-side-left">
        <div className="bj-vinyl"><div className="bj-vinyl-label"><b>♠</b></div></div>
        <div className="bj-stage-ticket"><b>GOOD<br />INSTINCTS</b><i /></div>
        <span className="bj-orbit-star">✳</span>
      </div>
      <div className="bj-side bj-side-right">
        <span className="bj-orbit-star">✧</span>
        <div className="bj-playing-card bj-playing-card-back"><span>A</span><b>♣</b></div>
        <div className="bj-playing-card bj-playing-card-front"><span>A<small>♥</small></span><b>♥</b></div>
        <div className="bj-side-wave">{Array.from({ length: 17 }, (_, index) => <i key={index} style={{ height: `${12 + ((index * 19) % 39)}px` }} />)}</div>
        <span className="bj-pixel-note" />
      </div>
    </div>
  );
}

export function BlackjackEmblem() {
  return (
    <div className="bj-heading-emblem" aria-hidden="true">
      <svg viewBox="0 0 240 180" fill="none">
        <ellipse cx="126" cy="162" rx="77" ry="10" fill="#080b1c" fillOpacity=".45" />
        <path className="buddy-spark" d="M27 29h9v9h9v9h-9v9h-9v-9h-9v-9h9ZM206 112h8v8h8v8h-8v8h-8v-8h-8v-8h8Z" fill="#ffaf98" />
        <g className="buddy-body">
          <rect x="83" y="18" width="104" height="130" rx="16" transform="rotate(14 83 18)" fill="#c3a5ff" stroke="#121323" strokeWidth="4" />
          <rect x="55" y="21" width="104" height="133" rx="16" transform="rotate(-9 55 21)" fill="#c4f58a" stroke="#121323" strokeWidth="4" />
          <path d="m99 49-23 25a16 16 0 0 0 26 18c0 11-3 17-8 20h27c-5-4-8-10-8-20a16 16 0 0 0 26-18l-24-25-8-9Z" fill="#253440" />
          <rect className="buddy-eye" x="87" y="72" width="6" height="10" rx="3" fill="#faf7ef" />
          <rect className="buddy-eye" x="116" y="72" width="6" height="10" rx="3" fill="#faf7ef" />
          <path d="M98 85q6 7 12 0" stroke="#faf7ef" strokeWidth="3" strokeLinecap="round" />
          <path d="m54 98-17 12-6-11M161 84l22-11 4-11M85 149l-7 11h-13M126 147l8 13h13" stroke="#c4f58a" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M67 39h10v10H67ZM141 117h10v10h-10Z" fill="#253440" />
        </g>
        <path className="buddy-note" d="M200 25v28m0-26 16-4v24" stroke="#80e5ca" strokeWidth="5" strokeLinecap="round" /><ellipse cx="195" cy="53" rx="7" ry="5" fill="#80e5ca" /><ellipse cx="211" cy="47" rx="7" ry="5" fill="#80e5ca" />
      </svg>
    </div>
  );
}
