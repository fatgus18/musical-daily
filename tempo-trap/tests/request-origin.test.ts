import test from "node:test";
import assert from "node:assert/strict";
import { sameOrigin as tempoOrigin } from "../src/lib/request-origin.ts";
import { sameOrigin as blackjackOrigin } from "../../blackjack-music/src/lib/request-origin.ts";

for (const [app, sameOrigin] of [["Tempo Trap", tempoOrigin], ["Blackjack", blackjackOrigin]] as const) {
  const internal = "http://127.0.0.1:3312/api/guess";
  const publicOrigin = "https://music.example";
  const request = (origin: string | undefined, host: string | undefined = "music.example", extra: Record<string, string> = {}, url = internal) =>
    new Request(url, { method: "POST", headers: { ...(origin === undefined ? {} : { origin }), ...(host === undefined ? {} : { host }), ...extra } });

  test(`${app}: a gateway's public Host permits same-site POSTs despite the internal Next URL`, () => {
    assert.equal(sameOrigin(request(publicOrigin)), true);
    assert.equal(sameOrigin(request("http://localhost:3301", "localhost:3301")), true);
    assert.equal(sameOrigin(request(publicOrigin, "MUSIC.EXAMPLE")), true);
    assert.equal(sameOrigin(request(publicOrigin, "music.example", {}, `${publicOrigin}/api/guess`)), true);
    assert.equal(sameOrigin(request("http://music.example", "music.example", {}, `${publicOrigin}/api/guess`)), false, "direct HTTPS requests still enforce the origin scheme");
    assert.equal(sameOrigin(request("https://music.example:444", "music.example")), false, "ports are part of the authority");
  });

  test(`${app}: malformed and cross-origin requests cannot spoof the public authority`, () => {
    for (const origin of ["null", "", "not-a-url", "https://evil.example", "https://music.example.evil.example", "https://music.example/other", "https://music.example?query", "https://music.example#fragment", "https://user@music.example", "ftp://music.example", "https://music.example https://evil.example"]) {
      assert.equal(sameOrigin(request(origin)), false, origin);
    }
    assert.equal(sameOrigin(request(publicOrigin, "evil.example", { "x-forwarded-host": "music.example", forwarded: "host=music.example;proto=https" })), false);
    assert.equal(sameOrigin(request(publicOrigin, "music.example", { "sec-fetch-site": "cross-site" })), false);
    assert.equal(sameOrigin(request(undefined, "music.example", { "sec-fetch-site": "cross-site" })), false);
  });

  test(`${app}: missing Origin supports API clients while missing Host uses the actual URL only`, () => {
    assert.equal(sameOrigin(request(undefined)), true);
    const direct = new Request(`${publicOrigin}/api/guess`, { method: "POST", headers: { origin: publicOrigin } });
    assert.equal(sameOrigin(direct), true);
    assert.equal(sameOrigin(new Request(internal, { method: "POST", headers: { origin: publicOrigin, "x-forwarded-host": "music.example" } })), false);
    assert.equal(sameOrigin(request(publicOrigin, "")), false);
  });
}
