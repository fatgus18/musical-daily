/** Original, purely decorative music buddy. No external imagery or audio. */
export function EncoreBuddy() {
  return <svg className="encore-buddy" viewBox="0 0 320 255" fill="none" aria-hidden="true">
    <ellipse cx="160" cy="231" rx="96" ry="12" fill="#080b1c" fillOpacity=".3" />
    <path className="buddy-spark" d="M45 39h10v10h10v10H55v10H45V59H35V49h10ZM266 150h8v8h8v8h-8v8h-8v-8h-8v-8h8Z" fill="#ffaf98" />
    <g className="buddy-body">
      <path d="m109 188-13 40H75M201 188l14 40h20M81 122l-31 18-12-8M235 121l24-17 6-21" stroke="#80e5ca" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="159" cy="126" r="79" fill="#80e5ca" stroke="#121323" strokeWidth="4" />
      <circle cx="159" cy="126" r="64" fill="#20233b" stroke="#121323" strokeWidth="4" />
      <circle cx="159" cy="126" r="51" stroke="#faf7ef" strokeOpacity=".2" strokeWidth="2" /><circle cx="159" cy="126" r="39" stroke="#faf7ef" strokeOpacity=".15" strokeWidth="2" />
      <path d="M83 115V92a76 76 0 0 1 152 0v23" stroke="#c3a5ff" strokeWidth="14" strokeLinecap="round" />
      <rect x="69" y="97" width="26" height="52" rx="12" fill="#c3a5ff" stroke="#121323" strokeWidth="4" /><rect x="222" y="97" width="26" height="52" rx="12" fill="#c3a5ff" stroke="#121323" strokeWidth="4" />
      <rect className="buddy-eye" x="138" y="111" width="8" height="15" rx="4" fill="#faf7ef" /><rect className="buddy-eye" x="174" y="111" width="8" height="15" rx="4" fill="#faf7ef" />
      <path d="M146 139q13 15 26 0" stroke="#faf7ef" strokeWidth="4" strokeLinecap="round" />
    </g><path className="buddy-note" d="M270 37v29m0-26 17-4v25" stroke="#c4f58a" strokeWidth="5" strokeLinecap="round" /><ellipse cx="264" cy="66" rx="8" ry="5" fill="#c4f58a" /><ellipse cx="281" cy="61" rx="8" ry="5" fill="#c4f58a" />
  </svg>;
}
