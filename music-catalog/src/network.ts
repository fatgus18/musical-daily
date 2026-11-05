import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ROOT } from "./store.ts";

let lastAppleRequest = 0;
export async function request(url: string, options: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (new URL(url).hostname === "itunes.apple.com") {
      const delay = Math.max(0, 3200 - (Date.now() - lastAppleRequest));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastAppleRequest = Date.now();
    }
    try {
      const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(45000), headers: { "User-Agent": "MusicalDailyCatalog/1.0", ...options.headers } });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
      if (attempt === 3) throw new Error(`HTTP ${response.status} after retries`);
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter ? Number(retryAfter) : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 2000 * 2 ** attempt;
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(1000, delay))));
    } catch (error) {
      if (attempt === 3 || (error instanceof Error && /^HTTP (4\d\d)/.test(error.message))) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
    }
  }
  throw new Error("Request failed");
}
export async function cachedText(url: string, filename: string, refresh = false) {
  const dir = resolve(ROOT, "data/cache"); await mkdir(dir, { recursive: true });
  const path = resolve(dir, filename);
  if (!path.startsWith(dir + "/") && !path.startsWith(dir + "\\")) throw new Error("Invalid cache path");
  if (!refresh) { try { return await readFile(path, "utf8"); } catch { /* Download missing cache. */ } }
  const text = await (await request(url, { signal: AbortSignal.timeout(300000) })).text();
  await writeFile(path + ".tmp", text); await rename(path + ".tmp", path);
  return text;
}
export function checksum(text: string) { return createHash("sha256").update(text).digest("hex"); }
