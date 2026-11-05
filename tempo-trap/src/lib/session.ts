import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Mode, RoundResult } from "./types";
import { hasCatalogVersion } from "./catalog";

export interface Session { version: string; date: string; seed: string; mode: Mode; results: RoundResult[]; expires: number; accountId?: string }
// Production requires an explicit stable secret; dev uses a process-wide random key.
const globalSecrets = globalThis as typeof globalThis & { tempoDevSecret?: string };
function secret() {
  if (process.env.TEMPO_SESSION_SECRET && process.env.TEMPO_SESSION_SECRET.length >= 32) return process.env.TEMPO_SESSION_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("Set TEMPO_SESSION_SECRET to at least 32 characters.");
  globalSecrets.tempoDevSecret ||= randomBytes(32).toString("hex");
  return globalSecrets.tempoDevSecret;
}
export function signSession(session: Session) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret()).update(payload).digest("base64url")}`;
}
export function readSession(token: unknown): Session {
  if (typeof token !== "string" || token.length > 12000) throw new Error("Invalid game session.");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("Invalid game session.");
  const expected = createHmac("sha256", secret()).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("This session has expired. Start a fresh mix.");
  const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
  if (!hasCatalogVersion(session.version) || session.expires < Date.now() || !Array.isArray(session.results) || session.results.length > 5) throw new Error("This mix has expired. Start a fresh mix.");
  return session;
}
