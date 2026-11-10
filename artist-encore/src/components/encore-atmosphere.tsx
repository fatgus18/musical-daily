/** Noninteractive concert ephemera; hidden from assistive technology. */
export function EncoreAtmosphere() {
  return <div className="encore-atmosphere" aria-hidden="true">
    <div className="encore-orbit" />
    <div className="encore-floating-pass"><strong>the<br />inner<br /><em>circle.</em></strong><i /></div>
    <div className="encore-floating-disc"><span className="encore-pixel-note" /></div>
    <span className="encore-floating-star">✳</span>
    <span className="encore-floating-star encore-star-two">✧</span>
  </div>;
}
