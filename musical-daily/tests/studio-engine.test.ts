import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { StudioEngine, midiFrequency, stepDuration } from "../src/lib/studio/engine.ts";
import { PATTERNS } from "../src/lib/studio/patterns.ts";
import { DRUMS, copyPattern, emptyPattern } from "../src/lib/studio/types.ts";

class Parameter {
  value = 0;
  events: { value: number; at: number }[] = [];
  setValueAtTime(value: number, at: number) { this.value = value; this.events.push({ value, at }); }
  linearRampToValueAtTime(value: number, at: number) { this.setValueAtTime(value, at); }
  exponentialRampToValueAtTime(value: number, at: number) { this.setValueAtTime(value, at); }
  setTargetAtTime(value: number, at: number) { this.setValueAtTime(value, at); }
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
}
class Node {
  gain = new Parameter(); frequency = new Parameter(); detune = new Parameter(); Q = new Parameter();
  threshold = new Parameter(); knee = new Parameter(); ratio = new Parameter(); attack = new Parameter(); release = new Parameter();
  type = "sine";
  fftSize = 256;
  connections: unknown[] = [];
  disconnected = false;
  connect(node: unknown) { this.connections.push(node); }
  disconnect() { this.disconnected = true; this.connections = []; }
  getFloatTimeDomainData(values: Float32Array) { values.fill(0.1); }
}
class Source extends Node {
  context: Context;
  buffer: unknown;
  onended: (() => void) | null = null;
  startedAt = Infinity;
  stopAt = Infinity;
  ended = false;
  constructor(context: Context) { super(); this.context = context; }
  start(at: number) { this.startedAt = at; }
  stop(at?: number) { this.stopAt = at ?? this.context.currentTime; }
  end() { if (!this.ended) { this.ended = true; this.onended?.(); } }
}
class Context {
  static instances: Context[] = [];
  static suspended = false;
  state = Context.suspended ? "suspended" : "running";
  currentTime = 0;
  sampleRate = 44100;
  destination = new Node();
  sources: Source[] = [];
  filters: Node[] = [];
  gains: Node[] = [];
  resumeCalls = 0;
  finishResume: (() => void) | null = null;
  constructor() { Context.instances.push(this); }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createDynamicsCompressor() { return new Node(); }
  createAnalyser() { return new Node(); }
  createBiquadFilter() { const node = new Node(); this.filters.push(node); return node; }
  createOscillator() { const node = new Source(this); this.sources.push(node); return node; }
  createBufferSource() { return this.createOscillator(); }
  createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  resume() { this.resumeCalls++; return new Promise<void>(resolve => { this.finishResume = () => { this.state = "running"; resolve(); }; }); }
  async close() { this.state = "closed"; }
  get pending() { return this.sources.filter(source => !source.disconnected && !source.ended && source.stopAt > this.currentTime); }
}

function setup(t: TestContext, suspended = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Context.instances = []; Context.suspended = suspended;
  Object.defineProperty(globalThis, "window", { value: { AudioContext: Context }, configurable: true });
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return (context: Context, seconds: number) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 0.005) {
      context.currentTime += 0.005;
      context.sources.forEach(source => { if (source.stopAt <= context.currentTime) source.end(); });
      t.mock.timers.tick(5);
    }
  };
}

test("music math uses A440 and swing keeps a 16-step bar in time", () => {
  assert.equal(midiFrequency(69), 440);
  assert.equal(midiFrequency(57), 220);
  assert.ok(Math.abs(midiFrequency(60) - 261.625565) < 0.00001);
  for (const swing of [0, 0.15, 0.5]) {
    const bar = Array.from({ length: 16 }, (_, step) => stepDuration(120, swing, step)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(bar - 2) < 0.000001);
  }
  assert.equal(stepDuration(120, 0.5, 0), 0.1875);
  assert.equal(stepDuration(120, 0.5, 1), 0.0625);
  assert.ok(Number.isFinite(stepDuration(NaN, Infinity, 0)));
});

test("all presets contain six independent 16-step lanes and clone safely", () => {
  assert.equal(new Set(PATTERNS.map(preset => preset.id)).size, PATTERNS.length);
  assert.ok(PATTERNS.some(preset => preset.id === "empty"));
  for (const preset of PATTERNS) for (const { id } of DRUMS) {
    assert.equal(preset.pattern[id].length, 16);
    assert.ok(preset.pattern[id].every(value => typeof value === "boolean"));
  }
  const original = emptyPattern(), clone = copyPattern(original);
  clone.kick[0] = true;
  assert.equal(original.kick[0], false);
  assert.equal(clone.snare[0], false);
});

test("the studio waits for a gesture and provides a separate post-master recording tap", async t => {
  setup(t);
  const engine = new StudioEngine(); t.after(() => engine.dispose());
  engine.setMasterVolume(0.5);
  assert.equal(Context.instances.length, 0);
  assert.equal(engine.getContext(), null);
  assert.equal(engine.getRecordingSource(), null);
  await engine.unlock();
  const context = Context.instances[0];
  const output = engine.getRecordingSource() as unknown as Node;
  assert.equal(context.gains[0].gain.value, 0.5);
  assert.ok(output.connections.includes(context.destination));
  const recorder = new Node(); output.connect(recorder);
  assert.ok(output.connections.includes(context.destination), "recording leaves speakers connected");
  assert.ok(output.connections.includes(recorder));
  engine.setMasterVolume(0); assert.equal(context.gains[0].gain.value, 0);
  engine.setMasterVolume(NaN); assert.equal(context.gains[0].gain.value, 0);
});

test("a released key cannot sound after an asynchronous browser unlock", async t => {
  setup(t, true);
  const errors: string[] = [], engine = new StudioEngine({ onError: message => errors.push(message) });
  t.after(() => engine.dispose());
  const note = engine.noteOn("a", 60, "keys");
  engine.noteOff("a");
  const context = Context.instances[0];
  context.finishResume!(); await note;
  assert.equal(context.sources.length, 0);
  assert.deepEqual(errors, []);
  await engine.noteOn("a", 60, "keys");
  assert.ok(context.pending.length > 0);
  engine.noteOff("a");
  assert.ok(context.sources.every(source => Number.isFinite(source.stopAt)));
});

test("stopAll cancels pending keys, drum hits, sequencer starts and meter work", async t => {
  const advance = setup(t, true);
  const steps: number[] = [], levels: number[] = [], errors: string[] = [];
  const engine = new StudioEngine({ onStep: step => steps.push(step), onMeter: level => levels.push(level), onError: error => errors.push(error) });
  t.after(() => engine.dispose());
  engine.setPattern(PATTERNS[2].pattern);
  const pending = [engine.noteOn("a", 60, "synth"), engine.hit("kick"), engine.startSequencer()];
  const context = Context.instances[0];
  assert.equal(context.resumeCalls, 1, "one resume promise serves concurrent inputs");
  engine.stopAll(); context.finishResume!(); await Promise.all(pending);
  advance(context, 1);
  assert.equal(context.sources.length, 0);
  assert.deepEqual(steps, [-1]);
  assert.deepEqual(levels, [0]);
  assert.deepEqual(errors, []);
});

test("polyphony and release tails remain bounded, and disposal cancels all voices", async t => {
  setup(t);
  const engine = new StudioEngine();
  for (let i = 0; i < 80; i++) await engine.noteOn(`key-${i}`, 48 + i % 36, "synth");
  const context = Context.instances[0];
  assert.ok(context.pending.length <= 32 * 3, "at most sixteen held voices plus sixteen short release tails");
  engine.allNotesOff(); assert.equal(context.pending.length, 0);
  await engine.noteOn("new", 60, "bell"); await engine.hit("openhat");
  assert.ok(context.pending.length > 0);
  engine.dispose(); assert.equal(context.pending.length, 0); assert.equal(context.state, "closed");
  await engine.noteOn("ignored", 60, "keys");
  assert.equal(context.pending.length, 0);
  await assert.rejects(engine.unlock(), /closed/);
});

test("the audio clock schedules swung hits accurately and cancels future hits on stop", async t => {
  const advance = setup(t);
  const steps: number[] = [], engine = new StudioEngine({ onStep: step => steps.push(step) });
  t.after(() => engine.dispose());
  const pattern = emptyPattern(); pattern.tom.fill(true);
  engine.setPattern(pattern); pattern.tom.fill(false);
  engine.setTempo(120); engine.setSwing(0.5);
  await engine.startSequencer();
  const context = Context.instances[0]; advance(context, 0.55);
  const times = context.sources.map(source => Number(source.startedAt.toFixed(4)));
  assert.deepEqual(times.slice(0, 5), [0.025, 0.2125, 0.275, 0.4625, 0.525]);
  assert.deepEqual(steps.slice(0, 5), [0, 1, 2, 3, 4]);
  engine.stopSequencer(); assert.equal(context.pending.length, 0);
  assert.equal(steps.at(-1), -1);
  const count = context.sources.length, updates = steps.length;
  advance(context, 2);
  assert.equal(context.sources.length, count); assert.equal(steps.length, updates);
});

test("percussion voices have distinct synthesis and muted lanes do not create audio", async t => {
  setup(t);
  const engine = new StudioEngine(); t.after(() => engine.dispose());
  await engine.hit("kick");
  const context = Context.instances[0];
  assert.equal(context.sources.length, 2, "kick combines a pitch sweep and transient");
  engine.stopAll(); await engine.hit("snare");
  assert.equal(context.sources.length, 4, "snare combines tone and filtered noise");
  assert.ok(context.filters.some(filter => filter.type === "highpass" && filter.frequency.value === 1600));
  await engine.hit("clap");
  assert.ok(context.filters.some(filter => filter.type === "bandpass"));
  const count = context.sources.length;
  engine.setDrumLevel("hat", 0); await engine.hit("hat");
  assert.equal(context.sources.length, count);
  await engine.hit("openhat"); await engine.hit("tom");
  assert.equal(context.sources.length, count + 2);
  engine.stopAll(); assert.equal(context.pending.length, 0);
});
