/** Original synthesized game sounds. No song samples, downloads, or autoplay. */
export type SoundCue = "click" | "select" | "start" | "correct" | "wrong" | "bank" | "risk" | "timeout" | "tick" | "complete";
export type MusicProfile = "game" | "lobby";
export interface SoundPreferences { enabled: boolean; effects: number; music: number }
export const DEFAULT_SOUND: SoundPreferences = { enabled: true, effects: 0.45, music: 0.16 };
export const SOUND_STORAGE_KEY = "musical-daily:sound:v1";
export function soundPreferences(value: unknown): SoundPreferences {
  const data = value && typeof value === "object" ? value as Partial<SoundPreferences> : {};
  const level = (input: unknown, fallback: number) => typeof input === "number" && Number.isFinite(input) ? Math.max(0, Math.min(1, input)) : fallback;
  return { enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SOUND.enabled, effects: level(data.effects, DEFAULT_SOUND.effects), music: level(data.music, DEFAULT_SOUND.music) };
}

type Voice = OscillatorNode | AudioBufferSourceNode;
export class MusicalSoundEngine {
  private context: AudioContext | null = null;
  private effects: GainNode | null = null;
  private music: GainNode | null = null;
  private preferences = DEFAULT_SOUND;
  private musicWanted = false;
  private visible = true;
  private previewing = false;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextBeat = 0;
  private lastCue = -Infinity;
  private effectVoices = new Set<Voice>();
  private musicVoices = new Set<Voice>();
  private noise: AudioBuffer | null = null;
  private profile: MusicProfile;

  constructor(profile: MusicProfile = "game") { this.profile = profile; }

  /** Must be called directly from a real click/key interaction. */
  unlock() {
    if (!this.preferences.enabled || !this.visible) return;
    try {
      if (!this.context) {
        const Constructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Constructor) return;
        const context = new Constructor(); this.context = context;
        const limiter = context.createDynamicsCompressor(); limiter.threshold.value = -16; limiter.ratio.value = 8;
        limiter.connect(context.destination);
        this.effects = context.createGain(); this.music = context.createGain();
        this.effects.connect(limiter); this.music.connect(limiter);
        this.applyVolume();
      }
      if (this.context.state === "suspended") void this.context.resume().then(() => this.reconcileMusic()).catch(() => {});
      this.reconcileMusic();
    } catch { /* Browsers without usable audio still play the entire game. */ }
  }
  configure(preferences: SoundPreferences) {
    this.preferences = soundPreferences(preferences); this.applyVolume();
    if (!preferences.enabled) { this.stopMusic(); this.stopVoices(this.effectVoices); }
    else this.reconcileMusic();
  }
  setMusic(active: boolean) { this.musicWanted = active; this.reconcileMusic(); }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) { this.stopMusic(); this.stopVoices(this.effectVoices); }
    else this.reconcileMusic();
  }
  setPreviewing(previewing: boolean) { this.previewing = previewing; this.reconcileMusic(); }
  private applyVolume() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.effects?.gain.setTargetAtTime(this.preferences.enabled ? this.preferences.effects * 0.7 : 0, now, 0.015);
    this.music?.gain.setTargetAtTime(this.preferences.enabled ? this.preferences.music * 0.55 : 0, now, 0.04);
  }
  private tone(frequency: number, at: number, length: number, volume: number, bus: "effects" | "music", type: OscillatorType = "sine", end?: number) {
    const context = this.context, target = bus === "effects" ? this.effects : this.music;
    if (!context || !target) return;
    const oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, at);
    if (end) oscillator.frequency.exponentialRampToValueAtTime(end, at + length);
    envelope.gain.setValueAtTime(0, at); envelope.gain.linearRampToValueAtTime(volume, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(envelope); envelope.connect(target);
    const voices = bus === "effects" ? this.effectVoices : this.musicVoices;
    voices.add(oscillator); oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); voices.delete(oscillator); };
    oscillator.start(at); oscillator.stop(at + length + 0.02);
  }
  play(cue: SoundCue) {
    const context = this.context;
    if (!context || context.state !== "running" || !this.preferences.enabled || !this.visible || this.preferences.effects === 0) return;
    const now = context.currentTime;
    if ((cue === "click" || cue === "select") && now - this.lastCue < 0.045) return;
    this.lastCue = now;
    const note = (frequency: number, delay: number, length = 0.13, volume = 0.12, type: OscillatorType = "sine", end?: number) => this.tone(frequency, now + delay, length, volume, "effects", type, end);
    switch (cue) {
      case "click": note(760, 0, 0.045, 0.055, "sine", 520); break;
      case "select": note(660, 0, 0.07, 0.07); note(880, 0.045, 0.08, 0.055); break;
      case "start": [330, 440, 554, 660].forEach((hz, i) => note(hz, i * 0.065, 0.2, 0.1, "triangle")); break;
      case "correct": [523, 659, 784, 1047].forEach((hz, i) => note(hz, i * 0.065, 0.2, 0.12, "triangle")); note(1568, 0.18, 0.22, 0.035); break;
      case "wrong": note(330, 0, 0.22, 0.14, "triangle", 165); note(147, 0.16, 0.25, 0.1, "sine", 82); break;
      case "timeout": [392, 311, 233].forEach((hz, i) => note(hz, i * 0.1, 0.18, 0.11, "triangle")); break;
      case "bank": [1319, 1760, 2093].forEach((hz, i) => note(hz, i * 0.055, 0.21, 0.075)); [523, 659, 784].forEach(hz => note(hz, 0.19, 0.35, 0.055, "triangle")); break;
      case "risk": [440, 554, 660, 880].forEach((hz, i) => note(hz, i * 0.045, 0.1, 0.07, "triangle")); break;
      case "tick": note(880, 0, 0.045, 0.045); break;
      case "complete": [523, 659, 784, 1047].forEach((hz, i) => note(hz, i * 0.09, 0.3, 0.095, "triangle")); break;
    }
  }
  private hat(at: number, accent: boolean) {
    const context = this.context; if (!context || !this.music) return;
    if (!this.noise) {
      this.noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.1), context.sampleRate);
      const data = this.noise.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain();
    source.buffer = this.noise; filter.type = "highpass"; filter.frequency.value = 6500;
    gain.gain.setValueAtTime(accent ? 0.05 : 0.022, at); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.055);
    source.connect(filter); filter.connect(gain); gain.connect(this.music); this.musicVoices.add(source);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); this.musicVoices.delete(source); };
    source.start(at); source.stop(at + 0.07);
  }
  private lobbyBeat(at: number) {
    // Eight bars of bright major-seventh chords, a bouncing bassline, and a
    // call-and-response hook. All voices are original synthesis, not samples.
    const position = this.step % 64, bar = Math.floor(position / 8), beat = position % 8;
    const root = [130.813, 130.813, 164.814, 164.814, 110, 110, 87.307, 97.999][bar];
    const chord = bar === 2 || bar === 3 || bar === 4 || bar === 5 ? [0, 3, 7, 10] : [0, 4, 7, 11];
    const phrase = bar % 2 === 0 ? [12, -1, 16, 19, -1, 16, 14, -1] : [12, 19, -1, 16, 14, -1, 12, -1];
    // Use chord tones for the minor bars so the melody follows the progression.
    const interval = phrase[beat] === 16 && chord[1] === 3 ? 15 : phrase[beat];
    if (interval >= 0) {
      this.tone(root * 2 ** (interval / 12), at, 0.14, 0.082, "music", "triangle");
      this.tone(root * 2 ** ((interval + 12) / 12), at, 0.18, 0.014, "music");
    }
    if (beat === 1 || beat === 4 || beat === 7) {
      chord.forEach((semitones, index) => this.tone(root * 2 ** (semitones / 12), at + index * 0.006, 0.14, 0.034, "music", "triangle"));
    }
    if (beat === 0 || beat === 3 || beat === 4 || beat === 6) {
      const bass = beat === 3 ? root * 0.75 : beat === 6 ? root : root / 2;
      this.tone(bass, at, 0.2, 0.14, "music");
    }
    if (beat === 0 || beat === 4) this.tone(125, at, 0.1, 0.14, "music", "sine", 45);
    if (beat === 2 || beat === 6) {
      this.tone(190, at, 0.055, 0.065, "music", "triangle", 125);
      this.hat(at, true);
    }
    if (beat % 2 === 1) this.hat(at, false);
  }
  private reconcileMusic() {
    const context = this.context;
    if (!context || context.state !== "running" || !this.musicWanted || !this.preferences.enabled || this.preferences.music === 0 || !this.visible || this.previewing) { this.stopMusic(); return; }
    if (this.scheduler) return;
    this.nextBeat = context.currentTime + 0.04;
    const schedule = () => {
      if (!this.context || this.context.state !== "running") { this.stopMusic(); return; }
      // Never play a backlog after a throttled or suspended tab.
      if (this.nextBeat < this.context.currentTime - 0.2) this.nextBeat = this.context.currentTime + 0.04;
      while (this.nextBeat < this.context.currentTime + 0.12) {
        if (this.profile === "lobby") {
          // A small swing on alternate eighth notes gives the lobby its bounce.
          this.lobbyBeat(this.nextBeat);
          this.nextBeat += 60 / 124 / 2 * (this.step % 2 === 0 ? 1.08 : 0.92);
          this.step++;
          continue;
        }
        const position = this.step % 64, root = [110, 87.307, 130.813, 97.999][Math.floor(position / 16)];
        const melody = [12, 19, 24, 19, 15, 19, 22, 19][position % 8];
        if (position % 2 === 0 || Math.floor(this.step / 64) % 2 === 1) this.tone(root * 2 ** (melody / 12), this.nextBeat, 0.13, 0.085, "music", "triangle");
        if (position % 4 === 0) { this.tone(root / 2, this.nextBeat, 0.2, 0.18, "music", "sine"); this.tone(125, this.nextBeat, 0.1, 0.16, "music", "sine", 45); }
        if (position % 4 === 2) this.tone(185, this.nextBeat, 0.06, 0.06, "music", "triangle", 125);
        this.hat(this.nextBeat, position % 2 === 1);
        this.nextBeat += 60 / 144 / 2; this.step++;
      }
    };
    schedule(); this.scheduler = setInterval(schedule, 35);
  }
  private stopVoices(voices: Set<Voice>) { for (const voice of voices) { try { voice.stop(); } catch {} } voices.clear(); }
  private stopMusic() { if (this.scheduler) clearInterval(this.scheduler); this.scheduler = null; this.stopVoices(this.musicVoices); }
  dispose() { this.stopMusic(); this.stopVoices(this.effectVoices); const context = this.context; this.context = null; this.effects = null; this.music = null; this.noise = null; if (context && context.state !== "closed") void context.close().catch(() => {}); }
}
