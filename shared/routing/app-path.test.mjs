import assert from "node:assert/strict";
import { test } from "node:test";

test("browser paths respect each service prefix without rewriting cross-service or external URLs", async () => {
  const previousBase = process.env.NEXT_PUBLIC_BASE_PATH;
  const previousHub = process.env.NEXT_PUBLIC_HUB_URL;
  try {
    for (const base of ["", "/blackjack", "/tempo-trap", "/encore", "/double-or-drop"]) {
      process.env.NEXT_PUBLIC_BASE_PATH = base;
      const { appBasePath, withBasePath } = await import(`./app-path.ts?base=${encodeURIComponent(base)}`);
      assert.equal(appBasePath, base);
      for (const path of ["/", "/stats", "/api/account/session", "/api/audio/42?offset=10#player", "/brand/musical-daily.svg"]) {
        assert.equal(withBasePath(path), `${base}${path}`);
        assert.equal(withBasePath(withBasePath(path)), withBasePath(path));
      }
      for (const path of ["", "relative/song", "./song", "../song", "?filter=all", "#keyboard", "https://example.com/a", "http://localhost:3001", "//cdn.example.com/song", "data:audio/wav;base64,AAA", "blob:https://example.com/recording"]) {
        assert.equal(withBasePath(path), path);
      }
      if (base) {
        for (const suffix of ["", "?artist=1", "#player", "/stats"]) assert.equal(withBasePath(`${base}${suffix}`), `${base}${suffix}`);
        assert.equal(withBasePath(`${base}-other`), `${base}${base}-other`);
      }
    }
    process.env.NEXT_PUBLIC_BASE_PATH = "/encore/";
    const trailing = await import("./app-path.ts?trailing");
    assert.equal(trailing.withBasePath("/api/session"), "/encore/api/session");
    delete process.env.NEXT_PUBLIC_HUB_URL;
    assert.equal(trailing.hubHref(), "http://localhost:3001");
    process.env.NEXT_PUBLIC_HUB_URL = "/";
    assert.equal(trailing.hubHref(), "/");
    process.env.NEXT_PUBLIC_HUB_URL = "https://music.example.com";
    assert.equal(trailing.hubHref(), "https://music.example.com");
  } finally {
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = previousBase;
    if (previousHub === undefined) delete process.env.NEXT_PUBLIC_HUB_URL;
    else process.env.NEXT_PUBLIC_HUB_URL = previousHub;
  }
});
