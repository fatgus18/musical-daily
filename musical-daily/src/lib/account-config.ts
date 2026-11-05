import { timingSafeEqual } from "node:crypto";
export const games = ["blackjack", "tempo", "encore", "double-drop"] as const;
export type GameId = typeof games[number];
export interface AccountConfig { hub: string; origins: Record<GameId, string>; secret: string; clientId: string; clientSecret: string; database: string; configured: boolean }
function origin(value: string | undefined, fallback: string, production: boolean) {
  if (production && !value) throw new Error("Explicit account origins are required in production");
  const url = new URL(value || fallback);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || (url.protocol !== "https:" && (production || !["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid account origin");
  return url.origin;
}
export function accountConfig(): AccountConfig {
  const prod = process.env.NODE_ENV === "production";
  const secret = process.env.MUSICAL_DAILY_SERVICE_SECRET || "";
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  // Without Google credentials, guest pages still work in an unconfigured build.
  const strict = prod && Boolean(clientId || clientSecret || secret);
  return {
    hub: origin(process.env.MUSICAL_DAILY_AUTH_ORIGIN, "http://localhost:3001", strict),
    origins: { blackjack: origin(process.env.MUSICAL_DAILY_BLACKJACK_ORIGIN, "http://localhost:3000", strict), tempo: origin(process.env.MUSICAL_DAILY_TEMPO_ORIGIN, "http://localhost:3002", strict), encore: origin(process.env.MUSICAL_DAILY_ENCORE_ORIGIN, "http://localhost:3004", strict), "double-drop": origin(process.env.MUSICAL_DAILY_DOUBLE_DROP_ORIGIN, "http://localhost:3005", strict) },
    secret, clientId, clientSecret, database: process.env.ACCOUNTS_DB_PATH || "data/accounts.sqlite",
    configured: Boolean(clientId && clientSecret && secret.length >= 32),
  };
}
export function equalSecret(actual: string, expected: string) { const a = Buffer.from(actual); const b = Buffer.from(expected); return b.length >= 32 && a.length === b.length && timingSafeEqual(a, b); }
export function safeReturnPath(value: string | null) { return value?.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(value) ? value : "/"; }
export function noStoreJson(body: unknown, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
export function redirect(location: string) { return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
export function readCookie(request: Request, name: string) { return request.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || ""; }
export function setCookie(response: Response, name: string, value: string, origin: string, maxAge: number) { response.headers.append("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`); }
