/**
 * Local production smoke-test fixture, NOT Vercel deployment verification.
 *
 * Build all five apps with scripts/service-next.mjs first, then run:
 *   node double-or-drop/tests/services/local-gateway.mjs
 *   cd double-or-drop && npx playwright test --config playwright.services.config.ts
 *
 * This simulates ingress using the exact supported service rewrite forms from
 * root vercel.json. It forwards the original URL, body and public Host header.
 * It does not emulate Vercel Functions, bindings, persistent storage or billing.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serviceEnvironment, servicePaths } from "../../../scripts/service-config.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const gatewayPort = 3100;
// Opt-in authentication integration fixture. Its sessions are seeded directly
// into disposable local storage by tests; no application login bypass exists.
const accountsFixture = process.env.ACCOUNTS_TEST_FIXTURE === "1";
const publicOrigin = `${accountsFixture ? "https" : "http"}://localhost:${gatewayPort}`;
const ports = Object.freeze({
  "musical-daily": 3311,
  "blackjack-music": 3310,
  "tempo-trap": 3312,
  "artist-encore": 3314,
  "double-or-drop": 3315,
});
const children = new Map();
let gateway;
let stopping = false;
let temporary;

function rewriteMatcher(source) {
  if (source === "/(.*)") return () => true;
  const match = /^(\/[a-z0-9-]+)\/:path\*$/.exec(source);
  if (!match) throw new Error(`Unsupported fixture rewrite: ${source}. Update this fixture to model the new route explicitly.`);
  const prefix = match[1];
  return path => path === prefix || path.startsWith(`${prefix}/`);
}

async function requireFreePort(port) {
  await new Promise((accept, reject) => {
    const probe = net.createServer();
    probe.once("error", error => reject(new Error(`Test port ${port} is unavailable: ${error.message}`)));
    probe.listen(port, "127.0.0.1", () => probe.close(accept));
  });
}

async function waitForApp(name, port) {
  const deadline = Date.now() + 90000;
  const url = `http://127.0.0.1:${port}${servicePaths[name] || "/"}`;
  while (Date.now() < deadline && !stopping) {
    const child = children.get(name);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited before readiness.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* The production process may still be starting. */ }
    await new Promise(accept => setTimeout(accept, 250));
  }
  throw new Error(`${name} did not become ready at ${url}. Build it with the services wrapper first.`);
}

function closeChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(accept => {
    let force;
    const finished = () => { clearTimeout(force); accept(); };
    child.once("exit", finished);
    // `next start` runs directly in this Node process. There is no shell, npm
    // wrapper or dev-server process tree to leave behind on Windows.
    child.kill("SIGTERM");
    force = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
  });
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  gateway?.close();
  gateway?.closeAllConnections();
  await Promise.all([...children.values()].map(closeChild));
  if (temporary) console.log(`Test-only storage retained at ${temporary}`);
  process.exit(code);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
if (process.platform === "win32") process.once("SIGBREAK", () => void shutdown());
if (accountsFixture) process.stdin.on("data", chunk => { if (String(chunk).trim() === "stop") void shutdown(); });
process.once("exit", () => {
  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});

async function main() {
  const configuration = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
  const names = Object.keys(configuration.services || {});
  if (names.length !== Object.keys(ports).length || names.some(name => !Object.hasOwn(ports, name))) {
    throw new Error("The fixture's five service ports must match vercel.json exactly.");
  }
  const routes = configuration.rewrites.map(rewrite => {
    const name = rewrite.destination?.service;
    if (!name || !Object.hasOwn(ports, name) || Object.keys(rewrite.destination).some(key => key !== "service")) {
      throw new Error(`Unsupported fixture destination for ${rewrite.source}.`);
    }
    return { name, matches: rewriteMatcher(rewrite.source) };
  });
  for (const name of names) {
    const directory = resolve(root, configuration.services[name].root);
    if (directory !== join(root, name)) throw new Error(`Unexpected service directory for ${name}.`);
    await access(join(directory, ".next", "BUILD_ID"));
  }
  for (const port of [gatewayPort, ...Object.values(ports)]) await requireFreePort(port);

  temporary = await mkdtemp(join(tmpdir(), "musical-daily-services-smoke-"));
  // Copy only the immutable current DoD release. New artist collections, if
  // manually tried, are published into the disposable fixture directory.
  const catalog = join(temporary, "double-or-drop", "catalog");
  await mkdir(join(catalog, "catalog-releases"), { recursive: true });
  const manifestPath = join(root, "double-or-drop", "data", "catalog-releases.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!/^[a-f0-9]{16}$/.test(manifest.current)) throw new Error("Invalid DoD release manifest.");
  await copyFile(manifestPath, join(catalog, "catalog-releases.json"));
  await copyFile(join(root, "double-or-drop", "data", "catalog-releases", `${manifest.current}.json`), join(catalog, "catalog-releases", `${manifest.current}.json`));
  const tempoSecret = randomBytes(32).toString("hex");
  const serviceSecret = randomBytes(32).toString("hex");
  let tlsOptions;
  if (accountsFixture) {
    const key = join(temporary, "localhost.key");
    const cert = join(temporary, "localhost.pem");
    const openssl = process.env.TEST_OPENSSL_PATH || (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", windowsHide: true });
    tlsOptions = { key: await readFile(key), cert: await readFile(cert) };
  }

  // Explicit empty values also block Next's dotenv loader from loading any
  // local cloud credentials. Test servers only ever use temporary SQLite.
  const cleanEnvironment = { ...process.env };
  for (const key of Object.keys(cleanEnvironment)) {
    if (/TURSO|^VERCEL|^GOOGLE_|^MUSICAL_DAILY_.*(?:SECRET|ORIGIN|SERVICE_URL)/.test(key)) cleanEnvironment[key] = "";
  }
  for (const prefix of ["ACCOUNTS", "ENCORE", "DOUBLE_DROP", "MUSIC_CACHE"]) {
    cleanEnvironment[`${prefix}_TURSO_DATABASE_URL`] = "";
    cleanEnvironment[`${prefix}_TURSO_AUTH_TOKEN`] = "";
  }
  Object.assign(cleanEnvironment, {
    VERCEL: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", MUSICAL_DAILY_SERVICE_SECRET: "",
    MUSICAL_DAILY_ACCOUNT_SERVICE_URL: "", MUSICAL_DAILY_AUTH_ORIGIN: "", MUSICAL_DAILY_APP_ORIGIN: "",
    MUSICAL_DAILY_BLACKJACK_ORIGIN: "", MUSICAL_DAILY_TEMPO_ORIGIN: "", MUSICAL_DAILY_ENCORE_ORIGIN: "", MUSICAL_DAILY_DOUBLE_DROP_ORIGIN: "",
  });

  for (const name of names) {
    const directory = join(root, name);
    const storage = join(temporary, name);
    await mkdir(storage, { recursive: true });
    const environment = serviceEnvironment(name, {
      ...cleanEnvironment,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(ports[name]),
      ACCOUNTS_DB_PATH: join(storage, "accounts.sqlite"),
      ENCORE_DB_PATH: join(storage, "encore.sqlite"),
      DOUBLE_DROP_DB_PATH: join(storage, "double-drop.sqlite"),
      MUSIC_PROVIDER_CACHE_PATH: join(storage, "provider-cache.sqlite"),
      ENCORE_CATALOG_CACHE_PATH: join(storage, "provider-cache.sqlite"),
      DOUBLE_DROP_CATALOG_DIR: catalog,
      TEMPO_SESSION_SECRET: tempoSecret,
      ENCORE_AUDIO_ENABLED: accountsFixture ? "true" : "false",
      NEXT_PUBLIC_GUEST_ONLY: accountsFixture ? "0" : "1",
      ...(accountsFixture ? {
        GOOGLE_CLIENT_ID: "fixture-client.invalid",
        GOOGLE_CLIENT_SECRET: "fixture-secret-not-valid-for-google",
        MUSICAL_DAILY_SERVICE_SECRET: serviceSecret,
        MUSICAL_DAILY_AUTH_ORIGIN: publicOrigin,
        MUSICAL_DAILY_APP_ORIGIN: publicOrigin,
        MUSICAL_DAILY_ACCOUNT_SERVICE_URL: "http://127.0.0.1:3311",
      } : {}),
    });
    // Use exactly the wrapper's environment, but spawn Next directly so the
    // only process to terminate is the production server we just created.
    const nextBinary = createRequire(join(directory, "package.json")).resolve("next/dist/bin/next");
    const child = spawn(process.execPath, [nextBinary, "start", "--port", String(ports[name]), "--hostname", "127.0.0.1"], {
      cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    children.set(name, child);
    child.stdout.on("data", chunk => process.stdout.write(`[${name}] ${chunk}`));
    child.stderr.on("data", chunk => process.stderr.write(`[${name}] ${chunk}`));
    child.once("error", error => { console.error(`${name}: ${error.message}`); void shutdown(1); });
    child.once("exit", (code, signal) => {
      if (!stopping) { console.error(`${name} exited unexpectedly (${code ?? signal}).`); void shutdown(1); }
    });
  }
  for (const name of names) await waitForApp(name, ports[name]);

  const handleRequest = (request, response) => {
    const path = new URL(request.url, "http://fixture.local").pathname;
    const route = routes.find(candidate => candidate.matches(path));
    if (!route) { response.writeHead(404); response.end("No matching service rewrite."); return; }
    const publicHost = request.headers.host || `localhost:${gatewayPort}`;
    const upstream = http.request({
      hostname: "127.0.0.1", port: ports[route.name], method: request.method, path: request.url,
      headers: {
        ...request.headers,
        host: publicHost,
        "x-forwarded-host": publicHost,
        "x-forwarded-proto": accountsFixture ? "https" : "http",
        "x-forwarded-port": String(gatewayPort),
      },
    }, incoming => {
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", error => {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" });
      response.end(`Local fixture could not reach ${route.name}: ${error.message}`);
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  };
  gateway = accountsFixture ? https.createServer(tlsOptions, handleRequest) : http.createServer(handleRequest);
  gateway.on("error", error => { console.error(error.message); void shutdown(1); });
  await new Promise(accept => gateway.listen(gatewayPort, "127.0.0.1", accept));
  if (accountsFixture) {
    const manifest = join(root, "test-results-accounts", "fixture.json");
    await mkdir(join(root, "test-results-accounts"), { recursive: true });
    await writeFile(manifest, JSON.stringify({ localFixture: true, origin: publicOrigin, temporary, accounts: join(temporary, "musical-daily", "accounts.sqlite"), encore: join(temporary, "artist-encore", "encore.sqlite"), doubleDrop: join(temporary, "double-or-drop", "double-drop.sqlite") }, null, 2));
    console.log(`Local auth fixture manifest: ${manifest}`);
  }
  console.log(`SIMULATED SERVICES INGRESS READY ${publicOrigin}`);
  console.log("Uses built production apps and vercel.json routing; this is not a Vercel emulator or storage migration.");
  console.log(`Disposable SQLite/cache directory: ${temporary}`);
}

main().catch(error => { console.error(error.message); void shutdown(1); });
