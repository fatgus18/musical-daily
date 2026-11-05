import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DEFAULT_SOUND, MusicalSoundEngine } from "../sound-engine.ts";

class Parameter {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
}
class AudioNodeStub {
  gain = new Parameter();
  frequency = new Parameter();
  threshold = new Parameter();
  ratio = new Parameter();
  connect() {}
  disconnect() {}
}
class Voice extends AudioNodeStub {
  type = "sine";
  buffer: unknown;
  onended: (() => void) | null = null;
  stopAt = Infinity;
  ended = false;
  startAt = Infinity;
  start(at: number) { this.startAt = at; }
  stop(at?: number) { this.stopAt = at ?? -Infinity; if (at === undefined) this.end(); }
  end() { if (!this.ended) { this.ended = true; this.onended?.(); } }
}
class AudioContextStub {
  static instances: AudioContextStub[] = [];
  state = "running";
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  voices: Voice[] = [];
  constructor() { AudioContextStub.instances.push(this); }
  createDynamicsCompressor() { return new AudioNodeStub(); }
  createGain() { return new AudioNodeStub(); }
  createBiquadFilter() { return new Voice(); }
  createOscillator() { const voice = new Voice(); this.voices.push(voice); return voice; }
  createBufferSource() { return this.createOscillator(); }
  createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
  get pending() { return this.voices.filter(voice => !voice.ended); }
}

function audio(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  AudioContextStub.instances = [];
  Object.defineProperty(globalThis, "window", { value: { AudioContext: AudioContextStub }, configurable: true });
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return (context: AudioContextStub, seconds = 1) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 0.035) {
      context.currentTime += 0.035;
      context.voices.forEach(voice => { if (voice.stopAt <= context.currentTime) voice.end(); });
      t.mock.timers.tick(35);
    }
  };
}

test("the lobby waits for a gesture and stops every scheduled voice when leaving home", t => {
  const advance = audio(t), engine = new MusicalSoundEngine("lobby");
  t.after(() => engine.dispose());
  engine.setMusic(true);
  assert.equal(AudioContextStub.instances.length, 0, "requesting music must not autoplay");
  engine.unlock();
  const context = AudioContextStub.instances[0];
  advance(context);
  assert.ok(context.pending.length > 0);
  assert.ok(context.voices.length > 10, "the loop continues after its first beat");
  engine.setMusic(false);
  assert.equal(context.pending.length, 0, "navigation cancels future notes as well as playing ones");
  const count = context.voices.length;
  advance(context, 2);
  engine.unlock();
  advance(context);
  assert.equal(context.voices.length, count, "clicks on another page must not restart lobby music");
});

test("mute, zero volume, hidden pages and previews stop lobby playback; disposal releases audio", t => {
  const advance = audio(t), engine = new MusicalSoundEngine("lobby");
  t.after(() => engine.dispose());
  engine.configure({ ...DEFAULT_SOUND, enabled: false });
  engine.setMusic(true);
  engine.unlock();
  assert.equal(AudioContextStub.instances.length, 0, "saved mute prevents unlocking");
  engine.configure(DEFAULT_SOUND);
  engine.unlock();
  const context = AudioContextStub.instances[0];
  for (const [pause, resume] of [
    [() => engine.setVisible(false), () => engine.setVisible(true)],
    [() => engine.configure({ ...DEFAULT_SOUND, music: 0 }), () => engine.configure(DEFAULT_SOUND)],
    [() => engine.configure({ ...DEFAULT_SOUND, enabled: false }), () => engine.configure(DEFAULT_SOUND)],
    [() => engine.setPreviewing(true), () => engine.setPreviewing(false)],
  ]) {
    pause();
    assert.equal(context.pending.length, 0);
    const count = context.voices.length;
    advance(context);
    assert.equal(context.voices.length, count);
    resume();
    advance(context);
    assert.ok(context.voices.length > count);
  }
  engine.dispose();
  assert.equal(context.pending.length, 0);
  assert.equal(context.state, "closed");
  const count = context.voices.length;
  advance(context);
  assert.equal(context.voices.length, count);
});

test("lobby and game use different arrangements while default preserves the game profile", t => {
  const advance = audio(t);
  const arrangement = (profile?: "game" | "lobby") => {
    const engine = new MusicalSoundEngine(profile);
    engine.setMusic(true);
    engine.unlock();
    const context = AudioContextStub.instances.at(-1)!;
    advance(context, 2);
    const notes = context.voices.map(voice => [voice.startAt, voice.frequency.value, voice.type]);
    engine.dispose();
    return notes;
  };
  const standard = arrangement();
  assert.deepEqual(arrangement("game"), standard);
  assert.notDeepEqual(arrangement("lobby"), standard);
});
