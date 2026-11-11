import assert from "node:assert/strict";
import { test } from "node:test";
import { getAccount, getStats, loadProgress, makeAccountRoutes, publishResult, publishResults, saveProgress } from "./server.mjs";

const secret = "test-service-secret-with-at-least-thirty-two-characters";
const publicOrigin = "https://music.example";
const user = { id: "one", name: "Listener", email: "listener@example.test", picture: null };
const keys = ["NODE_ENV", "NEXT_PUBLIC_BASE_PATH", "NEXT_PUBLIC_GUEST_ONLY", "NEXT_PUBLIC_MUSICAL_DAILY_SERVICES", "MUSICAL_DAILY_AUTH_ORIGIN", "MUSICAL_DAILY_APP_ORIGIN", "MUSICAL_DAILY_SERVICE_SECRET", "MUSICAL_DAILY_ACCOUNT_SERVICE_URL"];
async function environment(run) {
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  keys.forEach(key => delete process.env[key]);
  process.env.NODE_ENV = "production";
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = publicOrigin;
  process.env.MUSICAL_DAILY_APP_ORIGIN = publicOrigin;
  process.env.MUSICAL_DAILY_SERVICE_SECRET = secret;
  process.env.NEXT_PUBLIC_BASE_PATH = "/encore";
  process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES = "1";
  try { await run(); }
  finally {
    globalThis.fetch = originalFetch;
    keys.forEach(key => { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; });
  }
}
function request(path = "/api/account/session", options = {}) {
  return new Request(`${publicOrigin}/encore${path}`, { ...options, headers: { cookie: "md_hub_session=central-session; md_encore_session=old-session", ...options.headers } });
}
const cookies = response => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");

test("bindings resolve at request time and preserve internal path prefixes without dropping authorization", async () => environment(async () => {
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push(String(input));
    assert.equal(init.headers["X-Musical-Daily-Service"], secret);
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), { app: "encore", action: "session", token: "central-session" });
    return Response.json({ user, configured: true });
  };
  for (const base of ["http://hub.internal:4100", "http://hub.internal:4100/", "http://hub.internal:4100/services/musical-daily", "http://hub.internal:4100/services/musical-daily/"]) {
    process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL = base;
    assert.deepEqual(await getAccount(request(), "encore"), user);
    assert.equal(seen.at(-1), `${base.replace(/\/$/, "")}/api/account/service`);
  }
  delete process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL;
  await getAccount(request(), "encore");
  assert.equal(seen.at(-1), `${publicOrigin}/api/account/service`, "standalone apps retain their public hub fallback");
}));

test("bindings cannot weaken trusted public origins or send credentials to invalid internal URLs", async () => environment(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ user }); };
  process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL = "http://hub.internal";
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = `${publicOrigin}/encore`;
  await assert.rejects(getAccount(request(), "encore"), /Invalid account service origin/);
  process.env.MUSICAL_DAILY_AUTH_ORIGIN = publicOrigin;
  for (const invalid of ["ftp://hub.internal", "https://user:password@hub.internal", "https://hub.internal?token=secret", "https://hub.internal#fragment"]) {
    process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL = invalid;
    await assert.rejects(getAccount(request(), "encore"), /Invalid internal account service URL/);
  }
  process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL = "http://hub.internal";
  process.env.MUSICAL_DAILY_SERVICE_SECRET = "short";
  await assert.rejects(getAccount(request(), "encore"), /not configured/);
  assert.equal(calls, 0);
}));

test("all services use only the central cookie for sessions, statistics, progress and results", async () => environment(async () => {
  const seen = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    assert.equal(body.token, "central-session");
    return Response.json({ user, configured: true, progress: { revision: 1, value: { round: 1 } }, saved: true, revision: 2 });
  };
  const event = { eventId: "one", mode: "daily", score: 100, maxScore: 100 };
  for (const app of ["blackjack", "tempo", "encore", "double-drop"]) {
    const signed = request("/api/account/session", { headers: { cookie: `md_${app}_session=wrong-account; md_hub_session=central-session` } });
    assert.deepEqual(await getAccount(signed, app), user);
    await getStats(signed, app);
    await loadProgress(signed, app, "active");
    await saveProgress(signed, app, "active", { round: 2 }, 1);
    await publishResult(signed, app, event);
    await publishResults(signed, app, [event]);
    assert.deepEqual(seen.slice(-6).map(body => body.action), ["session", "stats", "load-progress", "save-progress", "result", "results"]);
    assert.ok(seen.slice(-6).every(body => body.app === app));
    const legacyOnly = request("/api/account/session", { headers: { cookie: `md_${app}_session=wrong-account` } });
    const count = seen.length;
    assert.equal(await getAccount(legacyOnly, app), null);
    assert.equal(await loadProgress(legacyOnly, app, "active"), null);
    assert.deepEqual(await saveProgress(legacyOnly, app, "active", {}, 0), { saved: false, revision: 0 });
    assert.deepEqual(await publishResult(legacyOnly, app, event), { saved: false });
    assert.deepEqual(await publishResults(legacyOnly, app, [event]), { saved: false });
    assert.equal(seen.length, count, "a previous game login must not resurrect another account");
  }
}));

test("services game login returns through central login without a separate game handoff", async () => environment(async () => {
  globalThis.fetch = async () => Response.json({ user: null, configured: true });
  // An old independent-game hostname must never affect single-domain routing.
  process.env.MUSICAL_DAILY_APP_ORIGIN = "https://music.examplec";
  const mounts = { blackjack: "/blackjack", tempo: "/tempo-trap", encore: "/encore", "double-drop": "/double-or-drop" };
  for (const [app, base] of Object.entries(mounts)) {
    process.env.NEXT_PUBLIC_BASE_PATH = base;
    const routes = makeAccountRoutes(app);
    for (const [returnTo, expected] of [["/stats?sort=recent", `${base}/stats?sort=recent`], [`${base}/stats`, `${base}/stats`], ["/", `${base}/`], ["//evil.example", `${base}/`], ["/%2e%2e//evil.example", `${base}/`], [`${base}/../stats`, `${base}/stats`]]) {
      const login = await routes.login(request(`/api/account/login?returnTo=${encodeURIComponent(returnTo)}`));
      assert.equal(login.status, 303);
      const target = new URL(login.headers.get("location"));
      assert.equal(target.origin, publicOrigin);
      assert.equal(target.pathname, "/api/account/login");
      assert.equal(target.searchParams.get("returnTo"), expected);
      assert.ok(login.headers.getSetCookie().every(value => /Max-Age=0/.test(value)), "no new per-game login or session cookie");
    }
  }
}));

test("services logout revokes and clears the central session, never the conflicting legacy account", async () => environment(async () => {
  process.env.MUSICAL_DAILY_APP_ORIGIN = "https://music.examplec";
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), { app: "encore", action: "logout", token: "central-session" });
    return Response.json({ ok: true });
  };
  const routes = makeAccountRoutes("encore");
  const response = await routes.logout(request("/api/account/logout", { method: "POST", headers: { origin: publicOrigin } }));
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.ok(response.headers.getSetCookie().some(value => /^md_hub_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/.test(value)));
  assert.equal((await routes.logout(request("/api/account/logout", { method: "POST", headers: { origin: "https://evil.example" } }))).status, 403);
  assert.equal(calls, 1);
}));

test("legacy standalone login and callback keep browser redirects public and preserve session cookies", async () => environment(async () => {
  delete process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES;
  process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL = "http://hub.internal/service-prefix";
  let claims = 0;
  const routes = makeAccountRoutes("encore", { onLogin: async account => { assert.deepEqual(account, user); claims++; } });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://hub.internal/service-prefix/api/account/service");
    const body = JSON.parse(init.body);
    if (body.action === "session") return Response.json({ user: null, configured: true });
    assert.equal(body.action, "exchange");
    return Response.json({ user, token: "verified-session", maxAge: 3600 });
  };
  const cases = new Map([
    ["/stats?sort=recent", "/encore/stats?sort=recent"],
    ["/encore/stats?sort=recent", "/encore/stats?sort=recent"],
    ["/encore", "/encore"],
    ["/", "/encore/"],
    ["//evil.example", "/encore/"],
    ["/%2e%2e//evil.example", "/encore/"],
    ["/encore/../stats", "/encore/stats"],
  ]);
  for (const [returnTo, expected] of cases) {
    const login = await routes.login(request(`/api/account/login?returnTo=${encodeURIComponent(returnTo)}`));
    assert.equal(login.status, 303);
    const authorization = new URL(login.headers.get("location"));
    assert.equal(authorization.origin, publicOrigin);
    assert.equal(authorization.pathname, "/api/auth/authorize");
    assert.doesNotMatch(login.headers.get("set-cookie"), /hub\.internal/);
    const complete = await routes.callback(request(`/api/account/callback?code=verified-code&state=${authorization.searchParams.get("state")}`, { headers: { cookie: cookies(login) } }));
    assert.equal(complete.headers.get("location"), `${publicOrigin}${expected}`);
    assert.match(complete.headers.get("set-cookie"), /md_encore_session=verified-session; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure/);
  }
  assert.equal(claims, cases.size);
  const failed = await routes.callback(request("/api/account/callback?code=bad&state=bad"));
  assert.equal(failed.headers.get("location"), `${publicOrigin}/encore/?accountError=sign-in-failed`);
  globalThis.fetch = async () => Response.json({ user: null, configured: false });
  const unavailable = await routes.login(request("/api/account/login"));
  assert.equal(unavailable.headers.get("location"), `${publicOrigin}/encore/?accountError=not-configured`);
}));

test("standalone login still returns to an unprefixed game path and same-origin checks reject path values", async () => environment(async () => {
  delete process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES;
  delete process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.MUSICAL_DAILY_APP_ORIGIN = "https://encore.example";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    return Response.json(body.action === "session" ? { user, configured: true } : { user, token: "session", maxAge: 3600 });
  };
  const routes = makeAccountRoutes("encore");
  const login = await routes.login(request("/api/account/login?returnTo=%2Fstats"));
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const callback = await routes.callback(request(`/api/account/callback?state=${state}&code=one`, { headers: { cookie: cookies(login) } }));
  assert.equal(callback.headers.get("location"), "https://encore.example/stats");
  const invalid = await routes.login(request(`/api/account/login?returnTo=${encodeURIComponent("/%2e%2e//evil.example")}`));
  const invalidState = new URL(invalid.headers.get("location")).searchParams.get("state");
  const safeCallback = await routes.callback(request(`/api/account/callback?state=${invalidState}&code=one`, { headers: { cookie: cookies(invalid) } }));
  assert.equal(safeCallback.headers.get("location"), "https://encore.example/");
  process.env.NEXT_PUBLIC_BASE_PATH = "/encore";
  assert.equal((await routes.logout(request("/api/account/logout", { method: "POST", headers: { origin: "https://encore.example/encore" } }))).status, 403);
  assert.equal((await routes.logout(request("/api/account/logout", { method: "POST", headers: { origin: "https://encore.example" } }))).status, 200);
}));

test("guest preview ignores stale account cookies and bindings without requiring account configuration", async () => environment(async () => {
  process.env.NEXT_PUBLIC_GUEST_ONLY = "1";
  process.env.MUSICAL_DAILY_ACCOUNT_SERVICE_URL = "not-a-url";
  delete process.env.MUSICAL_DAILY_AUTH_ORIGIN;
  delete process.env.MUSICAL_DAILY_APP_ORIGIN;
  delete process.env.MUSICAL_DAILY_SERVICE_SECRET;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("guest mode must not contact accounts"); };
  let claims = 0;
  const routes = makeAccountRoutes("encore", { onLogin: async () => { claims++; } });
  const signed = request();
  assert.equal(await getAccount(signed, "encore"), null);
  assert.equal(await loadProgress(signed, "encore", "active"), null);
  assert.deepEqual(await saveProgress(signed, "encore", "active", {}, 5), { saved: false, revision: 0 });
  assert.deepEqual(await publishResult(signed, "encore", {}), { saved: false });
  assert.deepEqual(await publishResults(signed, "encore", [{}]), { saved: false });
  assert.deepEqual(await (await routes.session(signed)).json(), { user: null, configured: false });
  const stats = await getStats(signed, "encore");
  assert.equal(stats.user, null);
  assert.deepEqual(Object.keys(stats.games), ["blackjack", "tempo", "encore", "double-drop"]);
  assert.ok(Object.values(stats.games).every(game => game.played === 0 && game.recent.length === 0));
  assert.deepEqual(await (await routes.stats(signed)).json(), stats);
  assert.equal((await routes.login(request("/api/account/login"))).status, 503);
  assert.equal((await routes.callback(request("/api/account/callback"))).status, 503);
  const logout = await routes.logout(request("/api/account/logout", { method: "POST", headers: { origin: publicOrigin } }));
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.equal(logout.headers.getSetCookie().length, 2);
  for (const value of logout.headers.getSetCookie()) assert.match(value, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure/);
  assert.equal((await routes.logout(request("/api/account/logout", { method: "POST", headers: { origin: "https://evil.example" } }))).status, 403);
  assert.equal((await routes.logout(request("/api/account/logout", { method: "POST" }))).status, 403);
  assert.equal(calls, 0);
  assert.equal(claims, 0);
}));
