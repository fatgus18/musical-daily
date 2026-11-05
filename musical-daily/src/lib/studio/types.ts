export type Instrument = "keys" | "synth" | "bass" | "bell";
export type DrumId = "kick" | "snare" | "clap" | "hat" | "openhat" | "tom";
export type Pattern = Record<DrumId, boolean[]>;

export const STEPS = 16;
export const DRUMS: readonly { id: DrumId; label: string; shortcut: string }[] = [
  { id: "kick", label: "Kick", shortcut: "1" },
  { id: "snare", label: "Snare", shortcut: "2" },
  { id: "clap", label: "Clap", shortcut: "3" },
  { id: "hat", label: "Hi-hat", shortcut: "4" },
  { id: "openhat", label: "Open hat", shortcut: "5" },
  { id: "tom", label: "Tom", shortcut: "6" },
];
export const INSTRUMENTS: readonly { id: Instrument; label: string }[] = [
  { id: "keys", label: "Velvet keys" },
  { id: "synth", label: "Analog synth" },
  { id: "bass", label: "Warm bass" },
  { id: "bell", label: "Glass bells" },
];

export interface StudioCallbacks {
  onStep?: (step: number) => void;
  onMeter?: (level: number) => void;
  onError?: (message: string) => void;
}

export interface PatternPreset {
  id: string;
  name: string;
  bpm: number;
  swing: number;
  pattern: Pattern;
}

export function emptyPattern(): Pattern {
  return Object.fromEntries(DRUMS.map(({ id }) => [id, Array<boolean>(STEPS).fill(false)])) as Pattern;
}

/** Clone on the boundary: editing the UI must never mutate a running preset. */
export function copyPattern(pattern: Pattern): Pattern {
  return Object.fromEntries(DRUMS.map(({ id }) => [id, Array.from({ length: STEPS }, (_, step) => pattern[id]?.[step] === true)])) as Pattern;
}
