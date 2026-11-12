import type { BrowserContext } from "@playwright/test";

/** Short PCM tone, sufficient for real browser decode/play/end tests. No network
 * or application API is mocked; the room media response alone is replaced. */
export function testWave(seconds = 30) {
  const rate = 8000;
  const samples = rate * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) bytes.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 220 / rate) * 1800), 44 + sample * 2);
  return bytes;
}

export async function roomMedia(context: BrowserContext, failure = false) {
  await context.route("**/api/rooms/**/audio**", async route => {
    if (failure) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test-only unavailable media" }) });
    else await route.fulfill({ status: 200, contentType: "audio/wav", body: testWave(), headers: { "cache-control": "no-store" } });
  });
}
