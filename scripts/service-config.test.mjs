import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serviceEnvironment, servicePaths } from "./service-config.mjs";

const deployment = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

test("public service URLs agree with routing for pages, API calls, static chunks, and artwork", () => {
  assert.deepEqual(Object.keys(deployment.services).sort(), Object.keys(servicePaths).sort());
  const rewrites = deployment.rewrites.map(rule => ({
    ...rule,
    pattern: new RegExp(`^${rule.source.replace("/:path*", "(?:/.*)?")}$`),
  }));
  const destination = pathname => rewrites.find(rule => rule.pattern.test(pathname))?.destination.service;
  for (const [service, mount] of Object.entries(servicePaths)) {
    const environment = serviceEnvironment(service, {});
    assert.equal(environment.NEXT_PUBLIC_BASE_PATH, mount);
    for (const suffix of ["", "/", "/stats", "/api/account/session", "/api/daily", "/_next/static/chunks/page.js", "/brand/musical-daily.svg"]) {
      assert.equal(destination(`${mount}${suffix}` || "/"), service, `${service}: ${suffix}`);
    }
  }
  for (const path of ["/rhythm-lab", "/audio/studio-recorder.js", "/api/account/service", "/encore-other", "/blackjackish"]) {
    assert.equal(destination(path), "musical-daily", path);
  }
  assert.equal(deployment.rewrites.at(-1).source, "/(.*)", "hub catch-all must follow the games");
  const urls = serviceEnvironment("musical-daily", {});
  for (const [key, service] of Object.entries({ NEXT_PUBLIC_BLACKJACK_URL: "blackjack-music", NEXT_PUBLIC_TEMPO_TRAP_URL: "tempo-trap", NEXT_PUBLIC_ENCORE_URL: "artist-encore", NEXT_PUBLIC_DOUBLE_DROP_URL: "double-or-drop" })) {
    assert.equal(destination(urls[key]), service, key);
  }
});

test("services builds overwrite stale localhost links while preserving runtime bindings and unrelated environment", () => {
  const inherited = Object.freeze({
    NODE_ENV: "production", PORT: "3456", TEMPO_SESSION_SECRET: "test-only-secret",
    NEXT_PUBLIC_HUB_URL: "http://localhost:3001", NEXT_PUBLIC_BLACKJACK_URL: "http://localhost:3000",
    NEXT_PUBLIC_BASE_PATH: "/wrong", NEXT_PUBLIC_GUEST_ONLY: "0",
    MUSICAL_DAILY_ACCOUNT_SERVICE_URL: "http://internal-hub.vercel.local:8080/",
  });
  const result = serviceEnvironment("tempo-trap", inherited);
  assert.equal(result.NEXT_PUBLIC_BASE_PATH, "/tempo-trap");
  assert.equal(result.NEXT_PUBLIC_HUB_URL, "/");
  assert.equal(result.NEXT_PUBLIC_BLACKJACK_URL, "/blackjack");
  assert.equal(result.NEXT_PUBLIC_GUEST_ONLY, "0");
  assert.equal(result.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES, "1");
  for (const key of ["NODE_ENV", "PORT", "TEMPO_SESSION_SECRET", "MUSICAL_DAILY_ACCOUNT_SERVICE_URL"]) assert.equal(result[key], inherited[key]);
  assert.equal(inherited.NEXT_PUBLIC_BASE_PATH, "/wrong");
  assert.equal(Object.hasOwn(serviceEnvironment("tempo-trap", {}), "MUSICAL_DAILY_ACCOUNT_SERVICE_URL"), false, "builds must not invent a runtime service binding");
  assert.throws(() => serviceEnvironment("accounts", {}), /Unknown service/);
});

test("accounts require explicit activation for every service and never default on", () => {
  for (const name of Object.keys(servicePaths)) {
    assert.equal(serviceEnvironment(name, {}).NEXT_PUBLIC_GUEST_ONLY, "1", name);
    assert.equal(serviceEnvironment(name, { NEXT_PUBLIC_GUEST_ONLY: "0" }).NEXT_PUBLIC_GUEST_ONLY, "0", name);
    for (const value of ["1", "", "false", "true", " 0", "0\n", undefined]) {
      assert.equal(serviceEnvironment(name, { NEXT_PUBLIC_GUEST_ONLY: value }).NEXT_PUBLIC_GUEST_ONLY, "1", `${name}: ${String(value)}`);
    }
  }
});

test("the shared account package is not deployed as a service and callers bind to the hub", () => {
  assert.equal(Object.hasOwn(deployment.services, "accounts"), false);
  for (const [name, service] of Object.entries(deployment.services)) {
    assert.equal(service.root, name);
    assert.equal(service.framework, "nextjs");
    assert.equal(service.buildCommand, `node ../scripts/service-next.mjs ${name} build`);
    assert.equal(service.devCommand, `node ../scripts/service-next.mjs ${name} dev`);
    const bindings = service.bindings ?? [];
    if (name === "musical-daily") assert.equal(bindings.length, 0);
    else assert.deepEqual(bindings, [{ type: "service", service: "musical-daily", format: "url", env: "MUSICAL_DAILY_ACCOUNT_SERVICE_URL" }]);
  }
});
