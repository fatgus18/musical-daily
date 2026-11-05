import { createWavBlob, createWavHeader, waveformPeaks } from "./wav.ts";

export const MAX_RECORDING_SECONDS = 300;
const modules = new WeakMap<AudioContext, Promise<void>>();

export type RecordedTake = {
  blob: Blob;
  duration: number;
  sampleRate: number;
  frames: number;
  peaks: number[];
};

type Options = { onLimit?: () => void; onError?: (message: string) => void };
type State = "idle" | "starting" | "recording" | "stopping" | "disposed";
type Pending = { reject: (reason: Error) => void };

/** One bounded in-memory take; attach only to the engine's post-master audio node. */
export class StudioRecorder {
  private readonly context: AudioContext;
  private readonly source: AudioNode;
  private readonly options: Options;
  private state: State = "idle";
  private generation = 0;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Int16Array[] = [];
  private frames = 0;
  private lastTake: RecordedTake | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<RecordedTake | null> | null = null;
  private pending = new Set<Pending>();
  private acknowledgements = new Map<string, () => void>();
  private interruptionReported = false;

  constructor(context: AudioContext, source: AudioNode, options: Options = {}) {
    if (source.context !== context) throw new Error("Recording source must belong to the studio audio context.");
    createWavHeader(context.sampleRate, 0);
    this.context = context;
    this.source = source;
    this.options = options;
  }

  start(): Promise<void> {
    if (this.state === "disposed") return Promise.reject(new Error("This recorder has been closed."));
    if (this.state === "starting") return this.startPromise!;
    if (this.state === "recording") return Promise.resolve();
    if (this.state === "stopping") return Promise.reject(new Error("Wait for the previous recording to finish."));
    this.state = "starting";
    this.chunks = [];
    this.frames = 0;
    this.lastTake = null;
    this.stopPromise = null;
    this.interruptionReported = false;
    const generation = ++this.generation;
    const promise = this.begin(generation).catch((error: unknown) => {
      if (generation === this.generation && this.state !== "disposed") {
        this.detach();
        this.chunks = [];
        this.frames = 0;
        this.state = "idle";
      }
      throw error;
    });
    this.startPromise = promise;
    return promise;
  }

  private async begin(generation: number): Promise<void> {
    if (!this.context.audioWorklet || typeof AudioWorkletNode === "undefined") {
      throw new Error("Recording needs a browser with AudioWorklet support. Open Rhythm Lab over HTTPS or localhost in a current browser.");
    }
    if (this.context.state === "closed") throw new Error("Audio was closed. Reload Rhythm Lab to record again.");
    if (this.context.state !== "running") {
      await this.wait(this.context.resume(), 4000, "Audio could not start. Tap an instrument, then try recording again.");
    }
    this.checkGeneration(generation);
    let module = modules.get(this.context);
    if (!module) {
      module = this.context.audioWorklet.addModule("/audio/studio-recorder.js");
      modules.set(this.context, module);
      void module.catch(() => { if (modules.get(this.context) === module) modules.delete(this.context); });
    }
    await this.wait(module, 8000, "The recorder could not load. Check your connection and try again.");
    this.checkGeneration(generation);
    const node = new AudioWorkletNode(this.context, "musical-daily-studio-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { maxFrames: Math.floor(this.context.sampleRate * MAX_RECORDING_SECONDS) },
    });
    const sink = this.context.createGain();
    sink.gain.value = 0;
    this.node = node;
    this.sink = sink;
    node.port.onmessage = (event: MessageEvent) => this.receive(event.data, generation);
    node.onprocessorerror = () => this.interrupt("The audio recorder was interrupted. Any captured audio is still available.");
    this.context.addEventListener("statechange", this.onContextState);
    this.source.connect(node);
    node.connect(sink);
    sink.connect(this.context.destination);
    const started = this.acknowledge("started", 2000, "The recorder did not start. Try again after tapping an instrument.");
    node.port.postMessage({ type: "start", id: generation });
    await started;
    this.checkGeneration(generation);
    if (this.context.state !== "running") throw new Error("Audio was paused before recording began. Try recording again.");
    this.state = "recording";
  }

  stop(): Promise<RecordedTake | null> {
    if (this.state === "disposed") return Promise.resolve(null);
    if (this.state === "stopping") return this.stopPromise!;
    if (this.state === "starting") {
      ++this.generation;
      this.cancelWaits("Recording was cancelled before it started.");
      this.detach();
      this.chunks = [];
      this.frames = 0;
      this.state = "idle";
      return Promise.resolve(null);
    }
    if (this.state === "idle") return Promise.resolve(this.lastTake);
    this.state = "stopping";
    const generation = this.generation;
    const promise = this.finish(generation);
    this.stopPromise = promise;
    return promise;
  }

  private async finish(generation: number): Promise<RecordedTake | null> {
    try {
      const stopped = this.acknowledge("stopped", 1200, "Audio paused before its final fraction of a second could be saved. The rest of your take is ready.");
      this.node?.port.postMessage({ type: "stop", id: generation });
      await stopped;
    } catch (error: unknown) {
      if (this.state !== "disposed" && generation === this.generation && !this.interruptionReported) {
        this.report(error instanceof Error ? error.message : "The recording ended early. Captured audio is still available.");
      }
    }
    if (this.state === "disposed" || generation !== this.generation) return null;
    this.detach();
    const chunks = this.chunks;
    this.chunks = [];
    this.state = "idle";
    if (!this.frames) return null;
    this.lastTake = {
      blob: createWavBlob(chunks, this.context.sampleRate),
      duration: this.frames / this.context.sampleRate,
      sampleRate: this.context.sampleRate,
      frames: this.frames,
      peaks: waveformPeaks(chunks),
    };
    return this.lastTake;
  }

  private receive(data: unknown, generation: number): void {
    if (generation !== this.generation || this.state === "disposed" || !data || typeof data !== "object") return;
    const message = data as { type?: string; id?: number; buffer?: unknown };
    if (message.id !== generation) return;
    if (message.type === "started" || message.type === "stopped") {
      this.acknowledgements.get(message.type)?.();
      return;
    }
    if (message.type === "chunk" && message.buffer instanceof ArrayBuffer) {
      const bytes = message.buffer.byteLength;
      if (!bytes || bytes > 8192 || bytes % 2) return;
      const available = Math.floor(this.context.sampleRate * MAX_RECORDING_SECONDS) - this.frames;
      if (available <= 0) return;
      const source = new Int16Array(message.buffer);
      const chunk = source.length > available ? source.slice(0, available) : source;
      this.chunks.push(chunk);
      this.frames += chunk.length;
    } else if (message.type === "limit" && this.state === "recording") {
      // Start finalizing before notifying the UI so repeated stop calls share one promise.
      void this.stop();
      try { this.options.onLimit?.(); } catch { /* UI callbacks cannot strand the audio graph. */ }
    }
  }

  private onContextState = (): void => {
    if (this.state === "recording" && this.context.state !== "running") {
      this.interrupt("Audio was interrupted, so recording stopped. Your captured take is still available; its final fraction of a second may be missing.");
    }
  };

  private interrupt(message: string): void {
    if (this.state === "starting") {
      this.cancelWaits(message);
      return;
    }
    if (this.state !== "recording") return;
    this.interruptionReported = true;
    void this.stop();
    this.report(message);
  }

  private report(message: string): void {
    try { this.options.onError?.(message); } catch { /* Preserve the take even if a UI callback fails. */ }
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation || this.state === "disposed") throw new Error("Recording was cancelled.");
  }

  private acknowledge(type: string, milliseconds: number, message: string): Promise<void> {
    let handler: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      handler = resolve;
      this.acknowledgements.set(type, resolve);
    });
    return this.wait(acknowledgement, milliseconds, message).finally(() => {
      if (this.acknowledgements.get(type) === handler) this.acknowledgements.delete(type);
    });
  }

  private wait<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const done = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(pending);
        if (error) reject(error); else resolve(value as T);
      };
      const pending: Pending = { reject: (error) => done(error) };
      this.pending.add(pending);
      timer = setTimeout(() => done(new Error(message)), milliseconds);
      promise.then((value) => done(undefined, value), (error: unknown) => done(error instanceof Error ? error : new Error(message)));
    });
  }

  private cancelWaits(message: string): void {
    for (const pending of this.pending) pending.reject(new Error(message));
    this.acknowledgements.clear();
  }

  private detach(): void {
    this.context.removeEventListener("statechange", this.onContextState);
    const node = this.node;
    this.node = null;
    if (node) {
      node.onprocessorerror = null;
      node.port.onmessage = null;
      try { node.port.postMessage({ type: "dispose" }); } catch { /* Already closed. */ }
      node.port.close();
      try { this.source.disconnect(node); } catch { /* Already detached. Never disconnect the live master. */ }
      node.disconnect();
    }
    this.sink?.disconnect();
    this.sink = null;
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    ++this.generation;
    this.cancelWaits("Recording was closed.");
    this.detach();
    this.chunks = [];
    this.frames = 0;
    this.lastTake = null;
    // A fulfilled stop promise retains its take, even after lastTake is cleared.
    this.startPromise = null;
    this.stopPromise = null;
  }
}
