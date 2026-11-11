// Server-only: this module must never be imported from a client component.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAccountAvatar } from "./types.mjs";

const ports = { blackjack: 3000, tempo: 3002, encore: 3004, "double-drop": 3005 };
const random = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const safePath = (value) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(value) ? value : "/";
const cookieName = (app) => `md_${app}_session`;
const guestOnly = () => process.env.NEXT_PUBLIC_GUEST_ONLY === "1";
const centralized = () => process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES === "1";
const sessionCookie = (app) => centralized() ? "md_hub_session" : cookieName(app);
const sessionToken = (request, app) => cookie(request, sessionCookie(app));
function publicPath(value) {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
  if (base && (!/^\/[a-zA-Z0-9_/-]+$/.test(base) || base.startsWith("//"))) throw new Error("Invalid game base path");
  // Normalize dot segments before prefixing, so a return path cannot escape its game.
  const target = new URL(safePath(value), "https://app.invalid");
  const path = safePath(target.pathname + target.search + target.hash);
  return !base || target.pathname === base || target.pathname.startsWith(`${base}/`) ? path : `${base}${path}`;
}
function emptyStats() {
  return { user: null, games: Object.fromEntries(Object.keys(ports).map(app => [app, { played: 0, completed: 0, incomplete: 0, wins: 0, totalScore: 0, bestScore: 0, averageScore: 0, averagePercent: 0, totalCorrect: 0, totalRounds: 0, totalBanked: 0, bestBanked: 0, currentStreak: 0, bestStreak: 0, lastPlayed: null, recent: [] }])) };
}
function cookie(request, name) { return request.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || ""; }
function origin(value, fallback) { const url = new URL(value || fallback); if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || (url.protocol !== "https:" && (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid account service origin"); return url.origin; }
function config(app) {
  if (!(app in ports)) throw new Error("Unknown game");
  const production = process.env.NODE_ENV === "production";
  if (production && (!process.env.MUSICAL_DAILY_AUTH_ORIGIN || (!centralized() && !process.env.MUSICAL_DAILY_APP_ORIGIN))) throw new Error("Account service origins must be configured in production");
  const hub = origin(process.env.MUSICAL_DAILY_AUTH_ORIGIN, "http://localhost:3001");
  // One public deployment has one trusted origin and one browser session.
  // A stale standalone APP_ORIGIN must never send signed-in visitors elsewhere.
  return { hub, appOrigin: centralized() ? hub : origin(process.env.MUSICAL_DAILY_APP_ORIGIN, `http://localhost:${ports[app]}`), secret: process.env.MUSICAL_DAILY_SERVICE_SECRET || "" };
}
function json(body, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
function cookieValue(name, value, appOrigin, maxAge) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appOrigin.startsWith("https:") ? "; Secure" : ""}`; }
function redirect(location) { return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
function sameOrigin(request, expected) { return request.headers.get("origin") === expected; }
async function avatarBody(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || Number(request.headers.get("content-length") || 0) > 1024 || !request.body) throw new Error("Invalid avatar selection");
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 1024) { await reader.cancel(); throw new Error("Invalid avatar selection"); }
    chunks.push(value);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "avatar") || body.avatar !== null && !isAccountAvatar(body.avatar)) throw new Error("Invalid avatar selection");
  return body.avatar;
}
function serviceEndpoint(publicHub) {
  // Service bindings only exist in running functions. Never use them for public redirects.
  const binding = process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL;
  const base = new URL(binding || publicHub);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid internal account service URL");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  return new URL("api/account/service", base);
}
async function central(request, app, action, data = {}) {
  const settings = config(app);
  if (settings.secret.length < 32) throw new Error("Account service is not configured");
  const response = await fetch(serviceEndpoint(settings.hub), { method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", "X-Musical-Daily-Service": settings.secret }, body: JSON.stringify({ app, action, token: sessionToken(request, app), ...data }) });
  if (response.status >= 500) throw new Error("Account service is temporarily unavailable");
  const payload = await response.json();
  if (!response.ok) { const error = new Error(payload.error || "Account request failed"); error.status = response.status; throw error; }
  return payload;
}
export async function getAccount(request, app) { if (guestOnly() || !sessionToken(request, app)) return null; return (await central(request, app, "session")).user; }
export async function publishResult(request, app, event) { if (guestOnly() || !sessionToken(request, app)) return { saved: false }; return central(request, app, "result", { event }); }
export async function publishResults(request, app, events) { if (guestOnly()) return { saved: false }; if (!Array.isArray(events) || !events.length || events.length > 50) throw new Error("Expected between one and fifty results"); if (!sessionToken(request, app)) return { saved: false }; return central(request, app, "results", { events }); }
export async function getStats(request, app) { return guestOnly() ? emptyStats() : central(request, app, "stats"); }
export async function loadProgress(request, app, key) { if (guestOnly() || !sessionToken(request, app)) return null; return (await central(request, app, "load-progress", { key })).progress; }
// Identity and progress come from one authoritative read; never cache this
// snapshot across requests because a session can be revoked at any time.
export async function loadAccountProgress(request, app, key) { if (guestOnly() || !sessionToken(request, app)) return { user: null, progress: null }; return central(request, app, "account-progress", { key }); }
export async function saveProgress(request, app, key, value, revision = 0, event) { if (guestOnly() || !sessionToken(request, app)) return { saved: false, revision: 0 }; return central(request, app, "save-progress", { key, value, revision, ...(event ? { event } : {}) }); }

export function makeAccountRoutes(app, hooks = {}) {
  return {
    async avatar(request) {
      if (guestOnly()) return json({ error: "Accounts are paused for this guest preview." }, 503);
      try {
        const settings = config(app);
        if (!sameOrigin(request, settings.appOrigin)) return json({ error: "Invalid request origin" }, 403);
        if (!sessionToken(request, app)) return json({ error: "Please sign in again" }, 401);
        let avatar;
        try { avatar = await avatarBody(request); } catch { return json({ error: "Invalid avatar selection" }, 400); }
        return json(await central(request, app, "avatar", { avatar }));
      } catch (error) {
        if (error.status === 401) return json({ error: "Please sign in again" }, 401);
        if (error.status === 400) return json({ error: "Invalid avatar selection" }, 400);
        return json({ error: "Your avatar could not be saved. Please retry." }, 503);
      }
    },
    async session(request) { if (guestOnly()) return json({ user: null, configured: false }); try { const settings = config(app); if (settings.secret.length < 32) { if (sessionToken(request, app)) throw new Error("Account service is not configured"); return json({ user: null, configured: false }); } return json(await central(request, app, "session")); } catch { return sessionToken(request, app) ? json({ error: "Account service is temporarily unavailable" }, 503) : json({ user: null, configured: false }); } },
    async login(request) {
      if (guestOnly()) return json({ error: "Google sign-in is disabled for this guest preview" }, 503);
      try {
        const settings = config(app);
        if (centralized()) {
          const target = new URL("/api/account/login", settings.hub);
          target.searchParams.set("returnTo", publicPath(new URL(request.url).searchParams.get("returnTo")));
          return redirect(target.toString());
        }
        const status = await central(request, app, "session");
        if (!status.configured) return redirect(`${settings.appOrigin}${publicPath("/?accountError=not-configured")}`);
        const state = random(); const verifier = random();
        const value = Buffer.from(JSON.stringify({ state, verifier, returnTo: publicPath(new URL(request.url).searchParams.get("returnTo")), expires: Date.now() + 600000 })).toString("base64url");
        const signed = `${value}.${createHmac("sha256", settings.secret).update(value).digest("base64url")}`;
        const target = new URL("/api/auth/authorize", settings.hub);
        target.search = new URLSearchParams({ app, state, challenge: digest(verifier) }).toString();
        const response = redirect(target.toString());
        response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, signed, settings.appOrigin, 600));
        return response;
      } catch { return json({ error: "Google sign-in is temporarily unavailable" }, 503); }
    },
    async callback(request) {
      if (guestOnly()) return json({ error: "Google sign-in is disabled for this guest preview" }, 503);
      const settings = config(app);
      // Old tabs may still have a standalone callback URL. Complete navigation
      // through the central session instead of installing another game cookie.
      if (centralized()) {
        const target = new URL("/api/account/login", settings.hub);
        target.searchParams.set("returnTo", publicPath("/"));
        return redirect(target.toString());
      }
      const fail = () => { const response = redirect(`${settings.appOrigin}${publicPath("/?accountError=sign-in-failed")}`); response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, "", settings.appOrigin, 0)); return response; };
      try {
        const [value, signature] = cookie(request, `md_${app}_login`).split(".");
        if (!value || !signature || settings.secret.length < 32) return fail();
        const expected = createHmac("sha256", settings.secret).update(value).digest(); const actual = Buffer.from(signature, "base64url");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail();
        const pending = JSON.parse(Buffer.from(value, "base64url").toString());
        const params = new URL(request.url).searchParams;
        if (pending.expires < Date.now() || params.get("state") !== pending.state || !params.get("code")) return fail();
        const exchanged = await central(request, app, "exchange", { code: params.get("code"), state: pending.state, verifier: pending.verifier });
        if (hooks.onLogin) await hooks.onLogin(exchanged.user, request);
        const response = redirect(new URL(publicPath(pending.returnTo), settings.appOrigin).toString());
        response.headers.append("Set-Cookie", cookieValue(cookieName(app), exchanged.token, settings.appOrigin, exchanged.maxAge));
        response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, "", settings.appOrigin, 0));
        return response;
      } catch { return fail(); }
    },
    async logout(request) {
      if (guestOnly()) {
        try {
          const appOrigin = process.env.MUSICAL_DAILY_APP_ORIGIN ? origin(process.env.MUSICAL_DAILY_APP_ORIGIN) : new URL(request.url).origin;
          if (!sameOrigin(request, appOrigin)) return json({ error: "Invalid request origin" }, 403);
          const response = json({ ok: true });
          response.headers.append("Set-Cookie", cookieValue(cookieName(app), "", appOrigin, 0));
          response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, "", appOrigin, 0));
          return response;
        } catch { return json({ error: "Could not sign out. Please retry." }, 503); }
      }
      try {
        const settings = config(app);
        if (!sameOrigin(request, settings.appOrigin)) return json({ error: "Invalid request origin" }, 403);
        if (sessionToken(request, app)) await central(request, app, "logout");
        const response = json({ ok: true });
        const names = centralized() ? ["md_hub_session", "md_google_flow", ...Object.keys(ports).flatMap(id => [cookieName(id), `md_${id}_login`])] : [cookieName(app)];
        for (const name of names) response.headers.append("Set-Cookie", cookieValue(name, "", settings.appOrigin, 0));
        return response;
      } catch { return json({ error: "Could not sign out. Please retry." }, 503); }
    },
    async stats(request) { try { return json(await getStats(request, app)); } catch { return json({ error: "Account statistics are temporarily unavailable" }, 503); } },
  };
}
