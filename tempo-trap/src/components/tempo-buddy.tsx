/** An abstract music character: its decorative motion never encodes a track's BPM. */
export function TempoBuddy() {
  return <div className="tempo-buddy" aria-hidden="true"><svg viewBox="0 0 220 166" fill="none">
    <ellipse cx="113" cy="152" rx="68" ry="9" fill="#080b1c" fillOpacity=".4" />
    <path className="buddy-spark" d="M19 30h8v8h8v8h-8v8h-8v-8h-8v-8h8ZM187 91h8v8h8v8h-8v8h-8v-8h-8v-8h8Z" fill="#c3a5ff" />
    <g className="buddy-body">
      <path d="m60 91-23-8-7-12M165 82l21-10 8-17M79 133l-9 17H55M139 133l11 17h14" stroke="#ffaf98" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="55" y="23" width="112" height="112" rx="24" transform="rotate(-5 55 23)" fill="#ffaf98" stroke="#121323" strokeWidth="4" />
      <path d="M76 39h56" stroke="#121323" strokeWidth="5" strokeLinecap="round" strokeDasharray="3 8" />
      <circle cx="114" cy="90" r="31" fill="#293048" stroke="#121323" strokeWidth="4" /><circle cx="114" cy="90" r="24" stroke="#faf7ef" strokeOpacity=".25" strokeWidth="2" />
      <rect className="buddy-eye" x="100" y="79" width="6" height="10" rx="3" fill="#faf7ef" /><rect className="buddy-eye" x="122" y="79" width="6" height="10" rx="3" fill="#faf7ef" />
      <path d="M106 97q8 9 16 0" stroke="#faf7ef" strokeWidth="3" strokeLinecap="round" /><circle cx="144" cy="39" r="7" fill="#c4f58a" stroke="#121323" strokeWidth="3" />
    </g><path className="buddy-note" d="M185 20v22m0-20 15-3v17" stroke="#c4f58a" strokeWidth="4" strokeLinecap="round" /><ellipse cx="181" cy="42" rx="6" ry="4" fill="#c4f58a" /><ellipse cx="196" cy="36" rx="6" ry="4" fill="#c4f58a" />
  </svg></div>;
}
