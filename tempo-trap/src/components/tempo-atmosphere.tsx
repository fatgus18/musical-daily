/** Scenery only: these marks never represent a song's tempo or game state. */
export function TempoAtmosphere() {
  return <div className="tempo-atmosphere" aria-hidden="true">
    <div className="tempo-orbit tempo-orbit-one" />
    <div className="tempo-orbit tempo-orbit-two" />
    <div className="tempo-side-disc"><i /></div>
    <div className="tempo-side-ticket"><strong>♪</strong><i /></div>
    <span className="tempo-spark tempo-spark-one">✳</span>
    <span className="tempo-spark tempo-spark-two">✧</span>
  </div>;
}
