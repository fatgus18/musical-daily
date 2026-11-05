import MusicStats from "./music-stats";

export default function Stats({ blackjackUrl, tempoUrl, encoreUrl, doubleDropUrl }: { blackjackUrl: string; tempoUrl: string; encoreUrl: string; doubleDropUrl: string }) {
  return <MusicStats hubUrl="/" gameUrls={{ blackjack: blackjackUrl, tempo: tempoUrl, encore: encoreUrl, "double-drop": doubleDropUrl }} />;
}

