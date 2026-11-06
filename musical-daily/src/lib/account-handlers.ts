import { AccountStore, AccountValidationError, randomToken, hash, SESSION_AGE } from "./account-store.ts";
import type { AuthFlow, Session } from "./account-store.ts";
import { accountConfig, equalSecret, games, noStoreJson, readCookie, redirect, safeReturnPath, setCookie } from "./account-config.ts";
import type { AccountConfig, GameId } from "./account-config.ts";
import { googleProvider } from "./google-provider.ts";
import type { GoogleProvider } from "./google-provider.ts";
import type { ResultEvent } from "@musical-daily/accounts";

const cookieName = "md_hub_session";
const flowCookie = "md_google_flow";
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
async function requestBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected JSON");
  if (Number(request.headers.get("content-length") || 0) > 150000) throw new Error("Request too large");
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 150000) { await reader.cancel(); throw new Error("Request too large"); } chunks.push(value); }
  const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request"); return body;
}

export function createAccountHandlers(config: AccountConfig, store: AccountStore, provider: GoogleProvider) {
  const hubSession = (request: Request) => store.session(readCookie(request, cookieName), "hub");
  function finish(session: Session, target: AuthFlow["target"], returnTo: string) {
    if (!target) return redirect(new URL(safeReturnPath(returnTo), config.hub).toString());
    const url = new URL(`${config.paths?.[target.app] || ""}/api/account/callback`, config.origins[target.app]);
    url.search = new URLSearchParams({ code: store.handoff(session, target.app, target.state, target.challenge), state: target.state }).toString();
    return redirect(url.toString());
  }
  async function start(request: Request, target: AuthFlow["target"], returnTo: string) {
    if (!config.configured) return redirect(`${config.hub}/?accountError=not-configured`);
    store.prune();
    const existing = hubSession(request);
    if (existing) return finish(existing, target, returnTo);
    const existingBrowser = readCookie(request, flowCookie); const browser = opaque(existingBrowser) ? existingBrowser : randomToken();
    if (!store.allow(`oauth:${hash(browser)}`, 15) || !store.allow("oauth:global", 1000)) return noStoreJson({ error: "Too many sign-in attempts. Please try again shortly." }, 429);
    const state = randomToken(); const verifier = randomToken(); const nonce = randomToken();
    store.putFlow(state, { browserHash: hash(browser), verifier, nonce, target, returnTo });
    const response = redirect(provider.authorization({ state, nonce, challenge: hash(verifier) }));
    setCookie(response, flowCookie, browser, config.hub, 600);
    return response;
  }
  return {
    async session(request: Request) { return noStoreJson({ user: hubSession(request)?.user || null, configured: config.configured }); },
    async stats(request: Request) { return noStoreJson(store.stats(hubSession(request)?.user || null)); },
    async login(request: Request) { return start(request, null, safeReturnPath(new URL(request.url).searchParams.get("returnTo"))); },
    async authorize(request: Request) {
      const params = new URL(request.url).searchParams; const app = params.get("app") as GameId; const state = params.get("state"); const challenge = params.get("challenge");
      if (!games.includes(app) || !opaque(state) || !opaque(challenge)) return noStoreJson({ error: "Invalid application sign-in request" }, 400);
      return start(request, { app, state, challenge }, "/");
    },
    async callback(request: Request) {
      const params = new URL(request.url).searchParams;
      const state = params.get("state"); const browser = readCookie(request, flowCookie);
      const fail = () => { const response = redirect(`${config.hub}/?accountError=sign-in-failed`); setCookie(response, flowCookie, "", config.hub, 0); return response; };
      if (!config.configured || !opaque(state) || !opaque(browser)) return fail();
      const flow = store.takeFlow(state, browser);
      if (!flow || params.has("error") || !params.get("code") || params.get("code")!.length > 4096) return fail();
      try {
        const identity = await provider.identity(params.get("code")!, flow.verifier, flow.nonce);
        const user = store.user(identity); const issued = store.createSession(user.id, "hub"); const session = store.session(issued.token, "hub")!;
        const response = finish(session, flow.target, flow.returnTo);
        setCookie(response, cookieName, issued.token, config.hub, SESSION_AGE);
        setCookie(response, flowCookie, "", config.hub, 0);
        return response;
      } catch { return fail(); }
    },
    async logout(request: Request) {
      if (request.headers.get("origin") !== config.hub) return noStoreJson({ error: "Invalid request origin" }, 403);
      const session = hubSession(request); if (session) store.revoke(session.family);
      const response = noStoreJson({ ok: true }); setCookie(response, cookieName, "", config.hub, 0); return response;
    },
    async service(request: Request) {
      // Only authenticated app servers may publish results or exchange login codes.
      if (request.headers.has("origin") || !equalSecret(request.headers.get("x-musical-daily-service") || "", config.secret)) return noStoreJson({ error: "Not authorized" }, 401);
      let body;
      try { body = await requestBody(request); } catch { return noStoreJson({ error: "Invalid request body" }, 400); }
      const { app, action } = body;
      if (!games.includes(app)) return noStoreJson({ error: "Unknown application" }, 400);
      if (action === "exchange") {
        if (!opaque(body.code) || !opaque(body.state) || !opaque(body.verifier)) return noStoreJson({ error: "Invalid sign-in exchange" }, 400);
        const exchanged = store.exchange(app, body.code, body.state, body.verifier);
        return exchanged ? noStoreJson(exchanged) : noStoreJson({ error: "This sign-in link has expired or was already used" }, 401);
      }
      const session = store.session(typeof body.token === "string" ? body.token : "", app);
      if (action === "session") return noStoreJson({ user: session?.user || null, configured: config.configured });
      if (action === "stats") return noStoreJson(store.stats(session?.user || null));
      if (!session) return noStoreJson({ error: "Please sign in again" }, 401);
      if (action === "logout") { store.revoke(session.family); return noStoreJson({ ok: true }); }
      try {
        if (action === "result") return noStoreJson(store.result(session.user.id, app, body.event as ResultEvent));
        if (action === "results") return noStoreJson(store.results(session.user.id, app, body.events as ResultEvent[]));
        if (action === "load-progress") return noStoreJson({ progress: store.loadProgress(session.user.id, app, body.key) });
        if (action === "save-progress") return noStoreJson(store.saveProgress(session.user.id, app, body.key, body.value, body.revision, body.event));
      } catch (error) {
        if (error instanceof AccountValidationError) return noStoreJson({ error: "Invalid account data" }, 400);
        console.error("Account service operation failed", { action, type: error instanceof Error ? error.name : "UnknownError" });
        return noStoreJson({ error: "Account storage is temporarily unavailable. Please retry." }, 503);
      }
      return noStoreJson({ error: "Unknown account action" }, 400);
    },
  };
}

const globalStore = globalThis as typeof globalThis & { musicalDailyAccounts?: { path: string; store: AccountStore } };
// Guest deployments must not open SQLite merely to report that sign-in is off.
function guestHandlers() {
  const unavailable = async (_request: Request) => noStoreJson({ error: "Accounts are paused for this guest preview.", configured: false }, 503);
  return {
    session: async (_request: Request) => noStoreJson({ user: null, configured: false }),
    stats: async (_request: Request) => noStoreJson({ error: "Account statistics are paused for this guest preview.", configured: false }, 401),
    login: unavailable, authorize: unavailable, callback: unavailable, service: unavailable,
    logout: async (request: Request) => {
      const publicOrigin = new URL(request.url).origin;
      if (request.headers.get("origin") !== publicOrigin) return noStoreJson({ error: "Invalid request origin" }, 403);
      const response = noStoreJson({ ok: true });
      setCookie(response, cookieName, "", publicOrigin, 0);
      setCookie(response, flowCookie, "", publicOrigin, 0);
      return response;
    },
  };
}
export function accountHandlers() {
  if (process.env.NEXT_PUBLIC_GUEST_ONLY === "1") return guestHandlers();
  const config = accountConfig();
  if (!globalStore.musicalDailyAccounts || globalStore.musicalDailyAccounts.path !== config.database) globalStore.musicalDailyAccounts = { path: config.database, store: new AccountStore(config.database) };
  // Next development reloads replace this class while retaining the live SQLite
  // connection. Refresh methods in place; closing it could interrupt an OAuth callback.
  if (Object.getPrototypeOf(globalStore.musicalDailyAccounts.store) !== AccountStore.prototype) Object.setPrototypeOf(globalStore.musicalDailyAccounts.store, AccountStore.prototype);
  return createAccountHandlers(config, globalStore.musicalDailyAccounts.store, googleProvider(config));
}
