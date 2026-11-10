/** An original little record buddy. Decorative; never sits over a control. */
export function ArcadeMascot({ playing = false, className = "" }: { playing?: boolean; className?: string }) {
  return <div className={`arcade-mascot ${playing ? "is-playing" : ""} ${className}`} aria-hidden="true">
    <svg viewBox="0 0 180 160" fill="none">
      <ellipse className="mascot-shadow" cx="89" cy="145" rx="42" ry="7" fill="#070818" opacity=".4"/>
      <g className="mascot-buddy" stroke="#121323" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path d="m65 113-9 23-15 1m73-24 12 22h16" stroke="#faf7ef" strokeWidth="7"/>
        <path d="M38 77 22 96 12 88m130-11 20 15 7-13" stroke="#faf7ef" strokeWidth="7"/>
        <circle cx="90" cy="75" r="52" fill="#c9b3ff"/>
        <circle cx="90" cy="75" r="40" stroke="#121323" strokeOpacity=".23" strokeWidth="2"/>
        <circle cx="90" cy="75" r="32" stroke="#121323" strokeOpacity=".23" strokeWidth="2"/>
        <circle cx="90" cy="75" r="24" fill="#faf7ef"/>
        <path d="M39 70V59a51 51 0 0 1 102 0v11" stroke="#121323" strokeWidth="11"/>
        <rect x="29" y="60" width="17" height="34" rx="7" fill="#c7f77b"/>
        <rect x="134" y="60" width="17" height="34" rx="7" fill="#c7f77b"/>
        <g className="mascot-eyes"><path d="M80 71v5m20-5v5" strokeWidth="5"/></g>
        <path d="M80 86q10 10 20 0" strokeWidth="3"/>
        <path d="M68 22h9m42 104h6" stroke="#faf7ef" strokeWidth="4"/>
      </g>
      <path className="mascot-note note-left" d="M14 34h5V19h11v5H19v10h-5v5H9v-5h5Z" fill="#ff9b8e"/>
      <path className="mascot-note note-right" d="M158 32h5V12h11v5h-6v20h-10v-5Z" fill="#c7f77b"/>
      <path className="mascot-twinkle" d="M155 111v6h6v6h-6v6h-6v-6h-6v-6h6v-6h6Z" fill="#ffcc64"/>
    </svg>
  </div>;
}
