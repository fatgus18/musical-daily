/** A small cheering crew for the lobby; decorative, never a source of game clues. */
export function DropBuddies() {
  return <svg className="drop-buddies" viewBox="0 0 440 310" fill="none" aria-hidden="true">
    <ellipse cx="221" cy="277" rx="161" ry="16" fill="#080b1c" fillOpacity=".4" />
    <path className="buddy-spark" d="M36 76h10v10h10v10H46v10H36V96H26V86h10ZM377 35h11v11h11v11h-11v11h-11V57h-11V46h11Z" fill="#ffaf98" />
    <g className="drop-buddy-one">
      <path d="m105 216-12 48H73M174 213l16 50h19M66 142l-27 3-10-12" stroke="#c4f58a" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="143" cy="135" r="93" fill="#c4f58a" stroke="#121323" strokeWidth="4" /><circle cx="143" cy="135" r="77" fill="#20233b" stroke="#121323" strokeWidth="4" /><circle cx="143" cy="135" r="62" stroke="#faf7ef" strokeOpacity=".22" strokeWidth="2" /><circle cx="143" cy="135" r="49" stroke="#faf7ef" strokeOpacity=".16" strokeWidth="2" />
      <rect className="buddy-eye" x="120" y="113" width="9" height="17" rx="4.5" fill="#faf7ef" /><rect className="buddy-eye" x="157" y="113" width="9" height="17" rx="4.5" fill="#faf7ef" /><path d="M128 148q15 18 30 0" stroke="#faf7ef" strokeWidth="4" strokeLinecap="round" />
    </g><g className="drop-buddy-two">
      <path d="m260 232-13 39h-20M325 226l17 45h23M360 149l31-8 9-14" stroke="#c3a5ff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="286" cy="156" r="91" fill="#c3a5ff" stroke="#121323" strokeWidth="4" /><circle cx="286" cy="156" r="75" fill="#20233b" stroke="#121323" strokeWidth="4" /><circle cx="286" cy="156" r="60" stroke="#faf7ef" strokeOpacity=".22" strokeWidth="2" /><circle cx="286" cy="156" r="48" stroke="#faf7ef" strokeOpacity=".16" strokeWidth="2" />
      <path d="m257 140 9-6 9 6" stroke="#faf7ef" strokeWidth="5" strokeLinecap="round" /><rect className="buddy-eye" x="303" y="130" width="9" height="17" rx="4.5" fill="#faf7ef" /><path d="M274 169q13 16 26 0" stroke="#faf7ef" strokeWidth="4" strokeLinecap="round" />
    </g><g transform="rotate(-7 225 242)"><rect x="120" y="224" width="222" height="48" rx="12" fill="#faf7ef" stroke="#121323" strokeWidth="3" /><text x="231" y="255" textAnchor="middle" fontSize="20" fontWeight="800" fontFamily="Arial, sans-serif" fill="#20233b">100 → 200 → 400</text></g>
  </svg>;
}
