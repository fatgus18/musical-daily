"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="error-page"><span className="eyebrow">LET’S TRY THAT AGAIN</span><h1>A little record scratch.</h1><p>We couldn’t load the game. Your saved run is kept on the server.</p><button className="button primary" onClick={reset}>Try again</button></main>;
}
