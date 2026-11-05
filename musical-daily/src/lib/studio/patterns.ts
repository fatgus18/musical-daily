import { emptyPattern, type DrumId, type Pattern, type PatternPreset } from "./types.ts";

function pattern(hits: Partial<Record<DrumId, number[]>>): Pattern {
  const result = emptyPattern();
  for (const [drum, steps] of Object.entries(hits)) {
    for (const step of steps) result[drum as DrumId][step] = true;
  }
  return result;
}

export const PATTERNS: readonly PatternPreset[] = [
  { id: "empty", name: "Blank canvas", bpm: 100, swing: 0, pattern: emptyPattern() },
  { id: "lofi", name: "Late-night lo-fi", bpm: 84, swing: 0.22, pattern: pattern({
    kick: [0, 6, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], openhat: [15],
  }) },
  { id: "house", name: "After-hours house", bpm: 124, swing: 0, pattern: pattern({
    kick: [0, 4, 8, 12], clap: [4, 12], hat: [2, 6, 10, 14], openhat: [6, 14],
  }) },
  { id: "breakbeat", name: "Pocket breakbeat", bpm: 136, swing: 0.08, pattern: pattern({
    kick: [0, 3, 8, 10], snare: [4, 12], hat: [0, 2, 3, 6, 8, 10, 11, 14], openhat: [7], tom: [15],
  }) },
];
