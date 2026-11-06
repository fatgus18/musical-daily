/* Captures the studio output only. This processor never requests a microphone. */
class StudioPCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.active = false;
    this.startPending = false;
    this.alive = true;
    this.id = 0;
    this.frames = 0;
    this.offset = 0;
    this.chunk = new Int16Array(4096);
    const requested = options.processorOptions?.maxFrames;
    this.maxFrames = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, Math.floor(sampleRate * 300))
      : Math.floor(sampleRate * 300);
    this.port.onmessage = ({ data }) => {
      if (data?.type === "start" && !this.active) {
        this.id = data.id;
        this.active = true;
        this.startPending = true;
        this.frames = 0;
        this.offset = 0;
      } else if (data?.type === "stop" && data.id === this.id) {
        this.active = false;
        this.startPending = false;
        this.flush();
        this.port.postMessage({ type: "stopped", id: this.id, frames: this.frames });
      } else if (data?.type === "dispose") {
        this.active = false;
        this.startPending = false;
        this.alive = false;
        this.offset = 0;
      }
    };
  }

  flush() {
    if (!this.offset) return;
    const samples = this.offset === this.chunk.length ? this.chunk : this.chunk.slice(0, this.offset);
    this.port.postMessage({ type: "chunk", id: this.id, buffer: samples.buffer }, [samples.buffer]);
    this.chunk = new Int16Array(4096);
    this.offset = 0;
  }

  process(inputs, outputs) {
    // Output stays silent; a zero-gain destination also protects against double playback.
    if (!this.active) return this.alive;
    const channels = inputs[0] || [];
    const quantum = channels[0]?.length || outputs[0]?.[0]?.length || 128;
    for (let i = 0; i < quantum && this.frames < this.maxFrames; i++) {
      let sample = 0;
      for (const channel of channels) sample += Number.isFinite(channel[i]) ? channel[i] : 0;
      if (channels.length) sample /= channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      this.chunk[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      this.frames++;
      // A port message can arrive before audio rendering starts. Only arm the UI
      // after a real render frame exists, before any chunk or limit messages.
      if (this.startPending) {
        this.startPending = false;
        this.port.postMessage({ type: "started", id: this.id });
      }
      if (this.offset === this.chunk.length) this.flush();
    }
    if (this.frames >= this.maxFrames) {
      this.active = false;
      this.flush();
      this.port.postMessage({ type: "limit", id: this.id, frames: this.frames });
    }
    return this.alive;
  }
}

registerProcessor("musical-daily-studio-recorder", StudioPCMRecorder);
