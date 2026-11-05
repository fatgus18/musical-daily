/** Canonical, uncompressed 16-bit mono WAV. Nothing is uploaded or persisted. */
const MAX_WAV_DATA_BYTES = 0xffffffff - 36;
const LITTLE_ENDIAN = new Uint8Array(new Int16Array([1]).buffer)[0] === 1;

export function pcm16Sample(value: number): number {
  const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  return Math.round(sample * (sample < 0 ? 32768 : 32767));
}

export function createWavHeader(sampleRate: number, frames: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 1000 || sampleRate > 384000) {
    throw new RangeError("Unsupported recording sample rate.");
  }
  if (!Number.isSafeInteger(frames) || frames < 0 || frames * 2 > MAX_WAV_DATA_BYTES) {
    throw new RangeError("Recording is too large for a WAV file.");
  }
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  return header;
}

export function pcm16Bytes(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return buffer;
}

export function createWavBlob(chunks: readonly Int16Array[], sampleRate: number): Blob {
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = createWavHeader(sampleRate, frames);
  // Reuse transferred PCM buffers on normal browser hardware instead of allocating
  // another whole take during export. The fallback preserves WAV byte order.
  const parts: BlobPart[] = chunks.map((chunk) => LITTLE_ENDIAN && chunk.buffer instanceof ArrayBuffer
    ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    : pcm16Bytes(chunk));
  return new Blob([header, ...parts], { type: "audio/wav" });
}

/** A fixed-size waveform makes even a long take cheap to draw. */
export function waveformPeaks(chunks: readonly Int16Array[], bins = 120): number[] {
  if (!Number.isInteger(bins) || bins < 1 || bins > 1024) throw new RangeError("Invalid waveform size.");
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!frames) return [];
  const count = Math.min(bins, frames);
  const peaks = Array<number>(count).fill(0);
  let index = 0;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const bin = Math.min(count - 1, Math.floor(index * count / frames));
      peaks[bin] = Math.max(peaks[bin], Math.abs(sample) / 32768);
      index++;
    }
  }
  return peaks;
}
