/** Noninteractive concert ephemera; hidden from assistive technology. */
export function EncoreAtmosphere() {
  return <div className="encore-atmosphere" aria-hidden="true">
    <div className="encore-orbit" />
    <div className="encore-margin-note"><span>FOR THE LOVE OF MUSIC</span><i /><span>YOUR PERSONAL LISTENING PARTY</span></div>
    <div className="encore-floating-pass"><small>ALL ACCESS</small><strong>the<br />inner<br /><em>circle.</em></strong><span>FANS ONLY. ALWAYS.</span><i /></div>
    <div className="encore-floating-disc"><span>ONE<br />MORE<br /><b>ENCORE.</b></span></div>
    <span className="encore-floating-star">✳</span>
    <span className="encore-floating-star encore-star-two">✧</span>
  </div>;
}
