// Server-only: this module must never be imported from a client component.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ports = { blackjack: 3000, tempo: 3002, encore: 3004, "double-drop": 3005 };
const random = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const safePath = (value) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(value) ? value : "/";
const cookieName = (app) => `md_${app}_session`;
function cookie(request, name) { return request.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || ""; }
function origin(value, fallback) { const url = new URL(value || fallback); if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || (url.protocol !== "https:" && (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid account service origin"); return url.origin; }
function config(app) {
  if (!(app in ports)) throw new Error("Unknown game");
  const production = process.env.NODE_ENV === "production";
  if (production && (!process.env.MUSICAL_DAILY_AUTH_ORIGIN || !process.env.MUSICAL_DAILY_APP_ORIGIN)) throw new Error("Account service origins must be configured in production");
  return { hub: origin(process.env.MUSICAL_DAILY_AUTH_ORIGIN, "http://localhost:3001"), appOrigin: origin(process.env.MUSICAL_DAILY_APP_ORIGIN, `http://localhost:${ports[app]}`), secret: process.env.MUSICAL_DAILY_SERVICE_SECRET || "" };
}
function json(body, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
function cookieValue(name, value, appOrigin, maxAge) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appOrigin.startsWith("https:") ? "; Secure" : ""}`; }
function redirect(location) { return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
function sameOrigin(request, expected) { return request.headers.get("origin") === expected; }
async function central(request, app, action, data = {}) {
  const settings = config(app);
  if (settings.secret.length < 32) throw new Error("Account service is not configured");
  const response = await fetch(`${settings.hub}/api/account/service`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", "X-Musical-Daily-Service": settings.secret }, body: JSON.stringify({ app, action, token: cookie(request, cookieName(app)), ...data }) });
  if (response.status >= 500) throw new Error("Account service is temporarily unavailable");
  const payload = await response.json();
  if (!response.ok) { const error = new Error(payload.error || "Account request failed"); error.status = response.status; throw error; }
  return payload;
}
export async function getAccount(request, app) { if (!cookie(request, cookieName(app))) return null; return (await central(request, app, "session")).user; }
export async function publishResult(request, app, event) { if (!cookie(request, cookieName(app))) return { saved: false }; return central(request, app, "result", { event }); }
export async function publishResults(request, app, events) { if (!Array.isArray(events) || !events.length || events.length > 50) throw new Error("Expected between one and fifty results"); if (!cookie(request, cookieName(app))) return { saved: false }; return central(request, app, "results", { events }); }
export async function getStats(request, app) { return central(request, app, "stats"); }
export async function loadProgress(request, app, key) { if (!cookie(request, cookieName(app))) return null; return (await central(request, app, "load-progress", { key })).progress; }
export async function saveProgress(request, app, key, value, revision = 0, event) { if (!cookie(request, cookieName(app))) return { saved: false, revision: 0 }; return central(request, app, "save-progress", { key, value, revision, ...(event ? { event } : {}) }); }

export function makeAccountRoutes(app, hooks = {}) {
  return {
    async session(request) { try { const settings = config(app); if (settings.secret.length < 32) { if (cookie(request, cookieName(app))) throw new Error("Account service is not configured"); return json({ user: null, configured: false }); } return json(await central(request, app, "session")); } catch { return cookie(request, cookieName(app)) ? json({ error: "Account service is temporarily unavailable" }, 503) : json({ user: null, configured: false }); } },
    async login(request) {
      try {
        const settings = config(app);
        const status = await central(request, app, "session");
        if (!status.configured) return redirect(`${settings.appOrigin}/?accountError=not-configured`);
        const state = random(); const verifier = random();
        const value = Buffer.from(JSON.stringify({ state, verifier, returnTo: safePath(new URL(request.url).searchParams.get("returnTo")), expires: Date.now() + 600000 })).toString("base64url");
        const signed = `${value}.${createHmac("sha256", settings.secret).update(value).digest("base64url")}`;
        const target = new URL("/api/auth/authorize", settings.hub);
        target.search = new URLSearchParams({ app, state, challenge: digest(verifier) }).toString();
        const response = redirect(target.toString());
        response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, signed, settings.appOrigin, 600));
        return response;
      } catch { return json({ error: "Google sign-in is temporarily unavailable" }, 503); }
    },
    async callback(request) {
      const settings = config(app);
      const fail = () => { const response = redirect(`${settings.appOrigin}/?accountError=sign-in-failed`); response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, "", settings.appOrigin, 0)); return response; };
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
        const response = redirect(new URL(safePath(pending.returnTo), settings.appOrigin).toString());
        response.headers.append("Set-Cookie", cookieValue(cookieName(app), exchanged.token, settings.appOrigin, exchanged.maxAge));
        response.headers.append("Set-Cookie", cookieValue(`md_${app}_login`, "", settings.appOrigin, 0));
        return response;
      } catch { return fail(); }
    },
    async logout(request) {
      try { const settings = config(app); if (!sameOrigin(request, settings.appOrigin)) return json({ error: "Invalid request origin" }, 403); if (cookie(request, cookieName(app))) await central(request, app, "logout"); const response = json({ ok: true }); response.headers.append("Set-Cookie", cookieValue(cookieName(app), "", settings.appOrigin, 0)); return response; } catch { return json({ error: "Could not sign out. Please retry." }, 503); }
    },
    async stats(request) { try { return json(await getStats(request, app)); } catch { return json({ error: "Account statistics are temporarily unavailable" }, 503); } },
  };
}
