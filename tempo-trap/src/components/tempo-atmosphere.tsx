/** Scenery only: these marks never represent a song's tempo or game state. */
export function TempoAtmosphere() {
  return <div className="tempo-atmosphere" aria-hidden="true">
    <div className="tempo-orbit tempo-orbit-one" />
    <div className="tempo-orbit tempo-orbit-two" />
    <div className="tempo-margin-note"><span>THE LISTENING ROOM</span><i /><span>FEEL MORE. THINK LESS.</span></div>
    <div className="tempo-side-disc"><i /><span>TRUST<br />YOUR<br /><b>EARS.</b></span></div>
    <div className="tempo-side-ticket"><span>ADMIT ONE</span><strong>Good<br />instincts.</strong><i /><small>NO PERFECT PITCH REQUIRED</small></div>
    <span className="tempo-spark tempo-spark-one">✳</span>
    <span className="tempo-spark tempo-spark-two">✧</span>
  </div>;
}
