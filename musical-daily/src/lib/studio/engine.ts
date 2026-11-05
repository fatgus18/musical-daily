import { DRUMS, copyPattern, emptyPattern, type DrumId, type Instrument, type Pattern, type StudioCallbacks } from "./types.ts";

type Source = OscillatorNode | AudioBufferSourceNode;
type Voice = { sources: Source[]; nodes: AudioNode[]; envelope: GainNode; release: number };
type DrumVoice = { sources: Source[]; nodes: AudioNode[]; output: GainNode; drum: DrumId; at: number; sequenced: boolean };
const MAX_POLYPHONY = 16;
const MAX_DRUM_VOICES = 48;
const LOOKAHEAD = 0.12;

function bounded(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
export function midiFrequency(midi: number) { return 440 * 2 ** ((bounded(midi, 21, 108, 60) - 69) / 12); }
/** Swing stretches the first sixteenth and shortens the next; a bar keeps its tempo. */
export function stepDuration(bpm: number, swing: number, step: number) {
  return 60 / bounded(bpm, 60, 200, 100) / 4 * (1 + (step % 2 === 0 ? 1 : -1) * bounded(swing, 0, 0.5, 0));
}

/** Original synthesis only. Audio is created lazily in a user gesture, never during render. */
export class StudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private output: GainNode | null = null;
  private toneFilter: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private noise: AudioBuffer | null = null;
  private callbacks: StudioCallbacks;
  private disposed = false;
  private generation = 0;
  private sequenceGeneration = 0;
  private resumePromise: Promise<void> | null = null;
  private noteRequests = new Map<string, symbol>();
  private voices = new Map<string, Voice>();
  private releasing = new Set<Voice>();
  private drums = new Set<DrumVoice>();
  private pattern = emptyPattern();
  private bpm = 100;
  private swing = 0;
  private volume = 0.72;
  private tone = 0.64;
  private drumLevels: Record<DrumId, number> = { kick: 0.85, snare: 0.65, clap: 0.6, hat: 0.45, openhat: 0.4, tom: 0.7 };
  private sequencer: ReturnType<typeof setInterval> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private stepTimers = new Set<ReturnType<typeof setTimeout>>();
  private step = 0;
  private nextStep = 0;

  constructor(callbacks: StudioCallbacks = {}) { this.callbacks = callbacks; }

  async unlock(): Promise<void> {
    if (this.disposed) throw new Error("This studio has closed. Reopen Rhythm Lab to play.");
    const generation = this.generation;
    if (!this.context) {
      if (typeof window === "undefined") throw new Error("Audio is only available in a browser.");
      const Constructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error("Your browser cannot play studio audio. Try a current browser.");
      const context = new Constructor({ latencyHint: "interactive" });
      this.context = context;
      this.master = context.createGain();
      this.master.gain.value = this.volume;
      this.toneFilter = context.createBiquadFilter();
      this.toneFilter.type = "lowpass";
      this.toneFilter.frequency.value = this.toneFrequency();
      this.toneFilter.Q.value = 0.3;
      this.toneFilter.connect(this.master);
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 3;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.09;
      this.output = context.createGain();
      this.output.gain.value = 0.82;
      this.master.connect(limiter);
      limiter.connect(this.output);
      this.output.connect(context.destination);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 256;
      this.output.connect(this.analyser);
      this.noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const noise = this.noise.getChannelData(0);
      for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    }
    const context = this.context;
    if (context.state === "closed") throw new Error("Audio stopped. Reopen Rhythm Lab to continue.");
    if (context.state !== "running") {
      if (!this.resumePromise) this.resumePromise = context.resume().finally(() => { this.resumePromise = null; });
      await this.resumePromise;
    }
    if (this.disposed || context !== this.context) throw new Error("This studio has closed.");
    if (generation !== this.generation) throw new Error("Audio start was cancelled.");
    if (context.state !== "running") throw new Error("Tap a key or drum to enable studio audio.");
    this.startMeter();
  }

  getContext() { return this.context; }
  /** A post-volume, post-limiter tap. Connecting a recorder does not alter speaker playback. */
  getRecordingSource(): AudioNode | null { return this.output; }

  private report(error: unknown) {
    if (!this.disposed) this.callbacks.onError?.(error instanceof Error ? error.message : "Audio could not start. Please try again.");
  }

  async noteOn(voiceId: string, midi: number, instrument: Instrument, velocity = 0.8): Promise<void> {
    if (this.disposed || this.noteRequests.has(voiceId)) return;
    const request = Symbol(voiceId), generation = this.generation;
    this.noteRequests.set(voiceId, request);
    try {
      await this.unlock();
      if (this.disposed || generation !== this.generation || this.noteRequests.get(voiceId) !== request) return;
      while (this.voices.size >= MAX_POLYPHONY) {
        const oldest = this.voices.keys().next().value;
        if (oldest === undefined) break;
        this.noteOff(oldest);
      }
      const context = this.context!, at = context.currentTime;
      const envelope = context.createGain();
      const frequency = midiFrequency(midi), strength = bounded(velocity, 0.05, 1, 0.8);
      const kind = ["keys", "synth", "bass", "bell"].includes(instrument) ? instrument : "keys";
      const release = kind === "bell" ? 0.55 : kind === "keys" ? 0.22 : 0.12;
      const voice: Voice = { sources: [], nodes: [envelope], envelope, release };
      this.voices.set(voiceId, voice);
      envelope.connect(this.toneFilter!);
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(strength * (kind === "bass" ? 0.25 : 0.19), at + (kind === "synth" ? 0.012 : 0.005));
      if (kind === "keys" || kind === "bell") {
        envelope.gain.exponentialRampToValueAtTime(strength * (kind === "bell" ? 0.035 : 0.06), at + 0.65);
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + (kind === "bell" ? 3.6 : 4.5));
      } else envelope.gain.exponentialRampToValueAtTime(strength * 0.135, at + 0.22);

      const partial = (ratio: number, gain: number, type: OscillatorType = "sine", detune = 0) => {
        if (frequency * ratio >= context.sampleRate / 2 - 200) return;
        const oscillator = context.createOscillator(), level = context.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency * ratio, at);
        oscillator.detune.value = detune;
        level.gain.value = gain;
        oscillator.connect(level); level.connect(envelope);
        voice.sources.push(oscillator); voice.nodes.push(level);
        oscillator.start(at);
      };
      if (kind === "keys") { partial(1, 0.72, "triangle"); partial(2, 0.2); partial(3, 0.075); partial(4, 0.025); }
      else if (kind === "synth") { partial(1, 0.34, "sawtooth", -5); partial(1, 0.34, "sawtooth", 5); partial(0.5, 0.22, "sine"); }
      else if (kind === "bass") { partial(1, 0.65); partial(1, 0.22, "triangle"); partial(2, 0.08); }
      else { partial(1, 0.62); partial(2, 0.2); partial(2.756, 0.11); partial(4.2, 0.04); }
      // Finite decaying instruments release their resources even when a pointer stays down.
      if (kind === "keys" || kind === "bell") {
        for (const source of voice.sources) source.stop(at + 5);
        voice.sources[0].onended = () => this.finishVoice(voiceId, voice);
      }
    } catch (error) {
      if (this.noteRequests.get(voiceId) === request) this.noteRequests.delete(voiceId);
      if (generation === this.generation) this.report(error);
    }
  }

  noteOff(voiceId: string): void {
    this.noteRequests.delete(voiceId);
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    this.voices.delete(voiceId);
    this.releaseVoice(voice);
  }

  private releaseVoice(voice: Voice, immediate = false) {
    const context = this.context;
    if (!context) return;
    if (immediate) { this.killVoice(voice); return; }
    const now = context.currentTime;
    this.releasing.add(voice);
    this.hold(voice.envelope.gain, now);
    voice.envelope.gain.linearRampToValueAtTime(0, now + voice.release);
    for (const source of voice.sources) {
      try { source.stop(now + voice.release + 0.02); } catch { /* Already ended. */ }
    }
    voice.sources[0].onended = () => this.killVoice(voice);
    // Repeated pointer taps cannot accumulate an unbounded release tail.
    while (this.releasing.size > MAX_POLYPHONY) this.killVoice(this.releasing.values().next().value!);
  }

  private finishVoice(id: string, voice: Voice) {
    if (this.voices.get(id) === voice) this.voices.delete(id);
    this.killVoice(voice);
  }

  private killVoice(voice: Voice) {
    this.releasing.delete(voice);
    for (const source of voice.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    }
    for (const node of voice.nodes) node.disconnect();
  }

  private hold(parameter: AudioParam, at: number) {
    if (typeof parameter.cancelAndHoldAtTime === "function") parameter.cancelAndHoldAtTime(at);
    else { const current = parameter.value; parameter.cancelScheduledValues(at); parameter.setValueAtTime(current, at); }
  }

  async hit(drum: DrumId, velocity = 0.85): Promise<void> {
    const generation = this.generation;
    if (!DRUMS.some(item => item.id === drum) || this.disposed) return;
    try {
      await this.unlock();
      if (this.disposed || generation !== this.generation) return;
      this.drum(drum, this.context!.currentTime, bounded(velocity, 0, 1, 0.85), false);
    } catch (error) { if (generation === this.generation) this.report(error); }
  }

  private drum(drum: DrumId, at: number, velocity: number, sequenced: boolean) {
    const context = this.context;
    if (!context || !this.master || !this.noise || this.drumLevels[drum] === 0 || velocity === 0) return;
    while (this.drums.size >= MAX_DRUM_VOICES) this.killDrum(this.drums.values().next().value!);
    if (drum === "hat") {
      for (const previous of this.drums) if (previous.drum === "openhat" && previous.at <= at) {
        this.hold(previous.output.gain, at);
        previous.output.gain.linearRampToValueAtTime(0, at + 0.014);
        for (const source of previous.sources) { try { source.stop(at + 0.015); } catch { /* Ended. */ } }
      }
    }
    const output = context.createGain();
    output.gain.value = this.drumLevels[drum] * velocity;
    output.connect(this.master);
    const voice: DrumVoice = { sources: [], nodes: [output], output, drum, at, sequenced };
    this.drums.add(voice);
    let ended = 0;
    const source = (input: Source, duration: number) => {
      voice.sources.push(input);
      input.onended = () => { if (++ended >= voice.sources.length) this.killDrum(voice); };
      input.start(at); input.stop(at + duration + 0.02);
    };
    const tonal = (from: number, to: number, duration: number, amplitude: number, type: OscillatorType = "sine") => {
      const oscillator = context.createOscillator(), envelope = context.createGain();
      oscillator.type = type; oscillator.frequency.setValueAtTime(from, at);
      oscillator.frequency.exponentialRampToValueAtTime(to, at + duration * 0.7);
      envelope.gain.setValueAtTime(0, at); envelope.gain.linearRampToValueAtTime(amplitude, at + 0.003);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(envelope); envelope.connect(output); voice.nodes.push(envelope);
      source(oscillator, duration);
    };
    const noisy = (duration: number, amplitude: number, frequency: number, type: BiquadFilterType, clap = false) => {
      const noise = context.createBufferSource(), filter = context.createBiquadFilter(), envelope = context.createGain();
      noise.buffer = this.noise; filter.type = type; filter.frequency.value = frequency; filter.Q.value = 0.7;
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(amplitude, at + 0.002);
      if (clap) {
        for (const offset of [0.012, 0.026]) {
          envelope.gain.exponentialRampToValueAtTime(0.001, at + offset - 0.002);
          envelope.gain.linearRampToValueAtTime(amplitude * 0.8, at + offset);
        }
      }
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      noise.connect(filter); filter.connect(envelope); envelope.connect(output);
      voice.nodes.push(filter, envelope); source(noise, duration);
    };
    if (drum === "kick") { tonal(145, 43, 0.46, 0.8); noisy(0.022, 0.1, 1700, "lowpass"); }
    else if (drum === "snare") { tonal(185, 115, 0.13, 0.23, "triangle"); noisy(0.22, 0.6, 1600, "highpass"); }
    else if (drum === "clap") noisy(0.19, 0.72, 1800, "bandpass", true);
    else if (drum === "hat") noisy(0.065, 0.4, 7400, "highpass");
    else if (drum === "openhat") noisy(0.46, 0.46, 6500, "highpass");
    else tonal(175, 82, 0.32, 0.6);
  }

  private killDrum(voice: DrumVoice) {
    this.drums.delete(voice);
    for (const source of voice.sources) { source.onended = null; try { source.stop(); } catch { /* Ended. */ } source.disconnect(); }
    for (const node of voice.nodes) node.disconnect();
  }

  setTempo(bpm: number) { this.bpm = bounded(bpm, 60, 200, this.bpm); }
  setSwing(amount: number) { this.swing = bounded(amount, 0, 0.5, this.swing); }
  setPattern(pattern: Pattern) { this.pattern = copyPattern(pattern); }
  setDrumLevel(drum: DrumId, value: number) {
    if (DRUMS.some(item => item.id === drum)) this.drumLevels[drum] = bounded(value, 0, 1, this.drumLevels[drum]);
  }
  setMasterVolume(value: number) {
    this.volume = bounded(value, 0, 1, this.volume);
    if (this.context && this.master) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.015);
  }
  private toneFrequency() { return Math.min(14000, 650 + this.tone ** 2 * 15500); }
  setTone(value: number) {
    this.tone = bounded(value, 0, 1, this.tone);
    if (this.context && this.toneFilter) this.toneFilter.frequency.setTargetAtTime(this.toneFrequency(), this.context.currentTime, 0.025);
  }

  async startSequencer(): Promise<void> {
    if (this.disposed || this.sequencer !== null) return;
    const request = ++this.sequenceGeneration;
    try {
      await this.unlock();
      if (this.disposed || request !== this.sequenceGeneration || this.sequencer !== null) return;
      this.step = 0; this.nextStep = this.context!.currentTime + 0.025;
      this.sequencer = setInterval(() => this.schedule(request), 25);
      this.schedule(request);
    } catch (error) { if (request === this.sequenceGeneration) this.report(error); }
  }

  private schedule(request: number) {
    const context = this.context;
    if (!context || this.disposed || request !== this.sequenceGeneration || context.state !== "running") return;
    // A backgrounded/throttled browser must not burst through every missed beat.
    if (this.nextStep < context.currentTime - 0.15) this.nextStep = context.currentTime + 0.015;
    while (this.nextStep < context.currentTime + LOOKAHEAD) {
      const step = this.step, at = this.nextStep;
      for (const { id } of DRUMS) if (this.pattern[id][step]) this.drum(id, at, step % 4 === 0 ? 0.95 : 0.82, true);
      const timer = setTimeout(() => {
        this.stepTimers.delete(timer);
        if (request === this.sequenceGeneration && !this.disposed) this.callbacks.onStep?.(step);
      }, Math.max(0, (at - context.currentTime) * 1000));
      this.stepTimers.add(timer);
      this.nextStep += stepDuration(this.bpm, this.swing, step);
      this.step = (step + 1) % 16;
    }
  }

  stopSequencer(): void {
    this.sequenceGeneration++;
    if (this.sequencer !== null) clearInterval(this.sequencer);
    this.sequencer = null;
    for (const timer of this.stepTimers) clearTimeout(timer);
    this.stepTimers.clear();
    for (const voice of this.drums) if (voice.sequenced) this.killDrum(voice);
    this.callbacks.onStep?.(-1);
  }

  allNotesOff(): void {
    this.noteRequests.clear();
    for (const voice of this.voices.values()) this.killVoice(voice);
    this.voices.clear();
    for (const voice of this.releasing) this.killVoice(voice);
  }

  stopAll(): void {
    this.generation++;
    this.stopSequencer();
    this.allNotesOff();
    for (const voice of this.drums) this.killDrum(voice);
    if (this.meter !== null) clearInterval(this.meter);
    this.meter = null;
    this.callbacks.onMeter?.(0);
  }

  private startMeter() {
    if (this.meter !== null || !this.analyser || !this.callbacks.onMeter) return;
    const samples = new Float32Array(this.analyser.fftSize);
    this.meter = setInterval(() => {
      if (this.disposed || !this.analyser || this.context?.state !== "running") return;
      this.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      this.callbacks.onMeter?.(Math.min(1, Math.sqrt(sum / samples.length) * 3.5));
    }, 50);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.disposed = true;
    if (this.meter !== null) clearInterval(this.meter);
    this.meter = null;
    this.output?.disconnect(); this.master?.disconnect(); this.toneFilter?.disconnect(); this.analyser?.disconnect();
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    this.context = null; this.master = null; this.output = null; this.toneFilter = null; this.analyser = null; this.noise = null;
  }
}
