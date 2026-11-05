export const LISTEN_SECONDS = 15;
export const GUESS_SECONDS = 15;
export const ROUNDS = 5;
export const MIN_BPM = 40;
export const MAX_BPM = 220;
export function isGuess(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_BPM && value <= MAX_BPM;
}
export function scoreGuess(guess: number | null, bpm: number) {
  if (guess === null) return { matchedBpm: bpm, difference: null, score: 0, label: "The beat got away" };
  // Accept the perceived half/double pulse; judge the same proportional error fairly.
  const pulses = [bpm, bpm / 2, bpm * 2].filter(n => n >= MIN_BPM && n <= MAX_BPM);
  const matchedBpm = pulses.reduce((best, n) => Math.abs(n - guess) / n < Math.abs(best - guess) / best ? n : best);
  const difference = Math.abs(matchedBpm - guess);
  const score = difference <= 2 ? 1000 : Math.round(1000 * Math.exp(-8 * (difference - 2) / matchedBpm));
  return { matchedBpm, difference, score, label: difference <= 2 ? "Right on the beat." : difference <= 6 ? "You’ve got the groove." : difference <= 15 ? "Pretty good instincts." : "A different rhythm." };
}
export function selectTracks<T extends { artist: string }>(tracks: T[], seedText: string): T[] {
  let seed = [...seedText].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const shuffled = [...tracks];
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const seen = new Set<string>();
  return shuffled.filter(track => { if (seen.has(track.artist)) return false; seen.add(track.artist); return true; }).slice(0, ROUNDS);
}
export function utcDate(now = new Date()) { return now.toISOString().slice(0, 10); }
export function puzzleNumber(date: string) { return Math.max(1, Math.floor((Date.parse(date) - Date.parse("2026-10-30")) / 86400000) + 1); }
export function rank(score: number) { return score >= 4500 ? "Human metronome" : score >= 3500 ? "In the pocket" : score >= 2000 ? "Finding your groove" : "Soundcheck complete"; }
