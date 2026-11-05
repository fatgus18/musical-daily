import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createWavBlob, createWavHeader, pcm16Bytes, pcm16Sample, waveformPeaks } from "../src/lib/studio/wav.ts";
import { MAX_RECORDING_SECONDS, StudioRecorder } from "../src/lib/studio/recording.ts";

test("WAV files describe their real PCM frames, rate and little-endian sample values", async () => {
  const samples = new Int16Array([-32768, -1, 0, 1, 32767]);
  const blob = createWavBlob([samples.subarray(0, 2), samples.subarray(2)], 48000);
  assert.equal(blob.type, "audio/wav");
  assert.equal(blob.size, 54);
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const text = (offset: number, length: number) => new TextDecoder().decode(buffer.slice(offset, offset + length));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(12, 4), "fmt ");
  assert.equal(text(36, 4), "data");
  assert.equal(view.getUint32(4, true), blob.size - 8);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 96000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
  for (let i = 0; i < samples.length; i++) assert.equal(view.getInt16(44 + i * 2, true), samples[i]);
  assert.deepEqual([...new Uint8Array(pcm16Bytes(new Int16Array([0x1234, -2])))], [0x34, 0x12, 0xfe, 0xff]);
});

test("PCM encoding and fixed-size waveform are bounded, including clipping and silence", () => {
  assert.deepEqual([-Infinity, NaN, -2, -1, -.5, 0, .5, 1, 2, Infinity].map(pcm16Sample),
    [0, 0, -32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
  assert.deepEqual(waveformPeaks([new Int16Array([-32768, 100, 0]), new Int16Array([0, 200, 16384])], 3), [1, 0, .5]);
  assert.deepEqual(waveformPeaks([], 120), []);
  assert.equal(waveformPeaks([new Int16Array([0, 0])]).length, 2);
  assert.throws(() => waveformPeaks([], 1025), RangeError);
  for (const rate of [0, NaN, Infinity, 44.1, 384001]) assert.throws(() => createWavHeader(rate, 0), RangeError);
  for (const frames of [-1, .5, NaN, 0x80000000]) assert.throws(() => createWavHeader(48000, frames), RangeError);
});

type WorkletMessage = { type: string; id: number; buffer?: ArrayBuffer; frames?: number };
type Processor = {
  port: { onmessage: (event: { data: object }) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
function worklet(maxFrames = 48000 * MAX_RECORDING_SECONDS) {
  const messages: WorkletMessage[] = [];
  let ProcessorClass: new (options: object) => Processor;
  runInNewContext(readFileSync(new URL("../public/audio/studio-recorder.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: WorkletMessage) => messages.push(message) }; },
    sampleRate: 48000, Int16Array, Float32Array, Number, Math,
    registerProcessor: (_name: string, constructor: typeof ProcessorClass) => { ProcessorClass = constructor; },
  });
  const processor = new ProcessorClass!({ processorOptions: { maxFrames } });
  const send = (type: string, id = 1) => processor.port.onmessage({ data: { type, id } });
  const process = (...channels: Float32Array[]) => processor.process([channels], [[new Float32Array(channels[0]?.length ?? 128)]]);
  const pcm = () => messages.filter((message) => message.type === "chunk").flatMap((message) => [...new Int16Array(message.buffer!)]);
  return { processor, messages, send, process, pcm };
}

test("actual worklet captures only inside start/stop, mixes stereo, flushes the last partial chunk", () => {
  const recorder = worklet();
  recorder.process(new Float32Array([1, 1]));
  recorder.send("start");
  recorder.process(new Float32Array([1, -.5, 0, NaN]), new Float32Array([-1, -.5, 1, 0]));
  recorder.send("stop", 99); // Wrong generation must not terminate this take.
  recorder.process(new Float32Array([.25]));
  recorder.send("stop");
  recorder.process(new Float32Array([1, 1]));
  assert.deepEqual(recorder.pcm(), [0, -16384, 16384, 0, 8192]);
  assert.deepEqual(recorder.messages.map((message) => message.type), ["started", "chunk", "stopped"]);
  assert.equal(recorder.messages.at(-1)?.frames, 5);
  recorder.send("dispose");
  assert.equal(recorder.process(new Float32Array([0])), false);
});

test("actual worklet handles changing quantum sizes, silent gaps and exact frame cap", () => {
  const recorder = worklet(4200);
  recorder.send("start");
  recorder.process(new Float32Array(3000).fill(.5));
  recorder.process(); // No connected input still records elapsed silent frames.
  recorder.process(new Float32Array(2000).fill(-.5));
  recorder.process(new Float32Array(256).fill(1));
  const chunks = recorder.messages.filter((message) => message.type === "chunk");
  assert.deepEqual(chunks.map((message) => message.buffer!.byteLength / 2), [4096, 104]);
  const samples = recorder.pcm();
  assert.equal(samples.length, 4200);
  assert.equal(samples[2999], 16384);
  assert.equal(samples[3000], 0);
  assert.equal(samples[3127], 0);
  assert.equal(samples[3128], -16384);
  assert.equal(recorder.messages.filter((message) => message.type === "limit").length, 1);
  recorder.send("stop");
  assert.equal(recorder.messages.at(-1)?.type, "stopped");
});

class MockContext {
  state = "running";
  sampleRate = 48000;
  destination = {};
  audioWorklet = { addModule: async (_url: string) => {} };
  listeners = new Set<() => void>();
  sinks: MockNode[] = [];
  createGain() { const node = new MockNode(this); this.sinks.push(node); return node; }
  async resume() { this.state = "running"; }
  addEventListener(_type: string, listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener); }
  interrupt() { this.state = "suspended"; for (const listener of this.listeners) listener(); }
}
class MockNode {
  context: MockContext;
  gain = { value: 1 };
  connections: object[] = [];
  disconnected: (object | undefined)[] = [];
  constructor(context: MockContext) { this.context = context; }
  connect(node: object) { this.connections.push(node); return node; }
  disconnect(node?: object) { this.disconnected.push(node); }
}
class MockWorkletNode extends MockNode {
  static nodes: MockWorkletNode[] = [];
  static acknowledgeStop = true;
  onprocessorerror: (() => void) | null = null;
  closed = false;
  id = 0;
  port = {
    onmessage: null as ((event: { data: object }) => void) | null,
    postMessage: (message: { type: string; id?: number }) => {
      if (message.type === "start") {
        this.id = message.id!;
        queueMicrotask(() => this.emit({ type: "started", id: this.id }));
      } else if (message.type === "stop" && MockWorkletNode.acknowledgeStop) {
        queueMicrotask(() => this.emit({ type: "stopped", id: this.id }));
      }
    },
    close: () => { this.closed = true; },
  };
  constructor(context: MockContext) { super(context); MockWorkletNode.nodes.push(this); }
  emit(message: object) { this.port.onmessage?.({ data: message }); }
  chunk(samples: number[], id = this.id) { this.emit({ type: "chunk", id, buffer: new Int16Array(samples).buffer }); }
}

test("recorder produces the actual captured take, detaches only its own branch and starts cleanly again", async () => {
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = MockWorkletNode as unknown as typeof AudioWorkletNode;
  try {
    const context = new MockContext();
    const source = new MockNode(context);
    const recorder = new StudioRecorder(context as unknown as AudioContext, source as unknown as AudioNode);
    const starting = recorder.start();
    assert.equal(recorder.start(), starting);
    await starting;
    const node = MockWorkletNode.nodes.at(-1)!;
    assert.equal(context.sinks[0].gain.value, 0);
    node.chunk([100, -100, 300]);
    node.chunk([9999], 999); // Stale worker data cannot enter this take.
    const stopping = recorder.stop();
    assert.equal(recorder.stop(), stopping);
    const take = await stopping;
    assert.equal(take?.frames, 3);
    assert.equal(take?.duration, 3 / 48000);
    assert.equal(take?.blob.size, 50);
    assert.deepEqual(source.disconnected, [node]);
    assert.equal(node.closed, true);
    assert.equal(context.listeners.size, 0);
    assert.equal(await recorder.stop(), take);
    await recorder.start();
    MockWorkletNode.nodes.at(-1)!.chunk([500]);
    assert.equal((await recorder.stop())?.frames, 1);
    recorder.dispose();
    assert.equal(await recorder.stop(), null);
    await assert.rejects(recorder.start(), /closed/);
  } finally { globalThis.AudioWorkletNode = previous; }
});

test("dispose and stop cancel stalled startup and leave no audio graph attached", async () => {
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = MockWorkletNode as unknown as typeof AudioWorkletNode;
  try {
    for (const dispose of [true, false]) {
      const context = new MockContext();
      context.audioWorklet.addModule = () => new Promise<void>(() => {});
      const source = new MockNode(context);
      const recorder = new StudioRecorder(context as unknown as AudioContext, source as unknown as AudioNode);
      const start = recorder.start();
      const rejected = assert.rejects(start, /closed|cancelled/);
      if (dispose) recorder.dispose(); else assert.equal(await recorder.stop(), null);
      await rejected;
      assert.equal(source.connections.length, 0);
      assert.equal(context.listeners.size, 0);
      recorder.dispose();
    }
  } finally { globalThis.AudioWorkletNode = previous; }
});

test("disposing a completed recorder releases its take and promise references", async () => {
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = MockWorkletNode as unknown as typeof AudioWorkletNode;
  try {
    const context = new MockContext();
    const source = new MockNode(context);
    const recorder = new StudioRecorder(context as unknown as AudioContext, source as unknown as AudioNode);
    await recorder.start();
    MockWorkletNode.nodes.at(-1)!.chunk([200, -200]);
    const take = await recorder.stop();
    assert.ok(take);
    // Inspect retention roots directly; garbage-collection timing is nondeterministic.
    assert.equal(await Reflect.get(recorder, "stopPromise"), take);
    recorder.dispose();
    for (const key of ["lastTake", "startPromise", "stopPromise", "node", "sink"]) {
      assert.equal(Reflect.get(recorder, key), null, `${key} must release its references`);
    }
    assert.deepEqual(Reflect.get(recorder, "chunks"), []);
    assert.equal(await recorder.stop(), null);
  } finally { globalThis.AudioWorkletNode = previous; }
});

test("an interrupted and unresponsive worklet returns retained audio instead of hanging", async () => {
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = MockWorkletNode as unknown as typeof AudioWorkletNode;
  MockWorkletNode.acknowledgeStop = false;
  try {
    const context = new MockContext();
    const source = new MockNode(context);
    const errors: string[] = [];
    const recorder = new StudioRecorder(context as unknown as AudioContext, source as unknown as AudioNode, { onError: (message) => errors.push(message) });
    await recorder.start();
    MockWorkletNode.nodes.at(-1)!.chunk([200, 400]);
    context.interrupt();
    const take = await recorder.stop();
    assert.equal(take?.frames, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /interrupted/);
    assert.equal(context.listeners.size, 0);
    recorder.dispose();
  } finally { globalThis.AudioWorkletNode = previous; MockWorkletNode.acknowledgeStop = true; }
});

test("the worklet frame cap finalizes once and its UI callback can safely call stop", async () => {
  const previous = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = MockWorkletNode as unknown as typeof AudioWorkletNode;
  try {
    const context = new MockContext();
    const source = new MockNode(context);
    let limitCount = 0;
    let result: Promise<import("../src/lib/studio/recording.ts").RecordedTake | null> | null = null;
    const recorder = new StudioRecorder(context as unknown as AudioContext, source as unknown as AudioNode, {
      onLimit: () => { limitCount++; result = recorder.stop(); },
    });
    await recorder.start();
    const node = MockWorkletNode.nodes.at(-1)!;
    node.chunk([1, 2, 3]);
    node.emit({ type: "limit", id: node.id });
    node.emit({ type: "limit", id: node.id });
    const take = await recorder.stop();
    assert.equal(limitCount, 1);
    assert.equal(await result, take);
    assert.equal(take?.frames, 3);
    recorder.dispose();
  } finally { globalThis.AudioWorkletNode = previous; }
});
