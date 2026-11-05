import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";

test("preview cache expires misses, coalesces lookups and repairs a newly failed URL once", async () => {
  const previousDirectory = process.cwd();
  const temporaryRoot = resolve(tmpdir());
  const testDirectory = mkdtempSync(resolve(temporaryRoot, "blackjack-preview-test-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  let requests = 0;
  let responseMode: "found" | "missing" | "outage" = "found";
  const first = "https://audio-ssl.itunes.apple.com/first.m4a";
  const second = "https://audio-ssl.itunes.apple.com/second.m4a";
  try {
    process.chdir(testDirectory);
    const { resolveTrackPreview } = await import("../src/lib/preview-media");
    // Advance the controlled clock on each API request so provider pacing is
    // covered without making this isolated cache test sleep for real seconds.
    Date.now = () => { now += 10_000; return now; };
    globalThis.fetch = async () => {
      requests += 1;
      if (responseMode === "outage") return new Response("Busy", { status: 429 });
      return Response.json({ results: responseMode === "missing" ? [] : [first, second].map(previewUrl => ({ kind: "song", trackName: "Song", artistName: "Artist", previewUrl })) });
    };
    const track = { id: "fixture", title: "Song", artist: "Artist", releaseYear: 2020, streams: 1 };
    const [a, b] = await Promise.all([resolveTrackPreview(track), resolveTrackPreview(track)]);
    assert.equal(a.previewUrl, first);
    assert.deepEqual(a, b);
    assert.equal(requests, 1, "duplicate requests share one provider lookup");
    assert.equal((await resolveTrackPreview(track)).previewUrl, first);
    assert.equal(requests, 1, "fresh cache avoids provider calls");
    assert.equal((await resolveTrackPreview(track, true)).previewUrl, second, "failed fresh URL can immediately find a different matching preview");
    assert.equal(requests, 2);

    responseMode = "missing";
    const absent = { ...track, id: "missing" };
    assert.equal((await resolveTrackPreview(absent)).previewStatus, "unavailable");
    const missRequests = requests;
    await resolveTrackPreview(absent);
    assert.equal(requests, missRequests);
    now += 7 * 3_600_000;
    responseMode = "found";
    assert.equal((await resolveTrackPreview(absent)).previewUrl, first, "confirmed misses expire");

    responseMode = "outage";
    assert.equal((await resolveTrackPreview({ ...track, id: "outage" })).previewStatus, "retry", "provider failures are not permanent unavailability");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    process.chdir(previousDirectory);
    const childPath = relative(temporaryRoot, resolve(testDirectory));
    assert.ok(childPath.startsWith("blackjack-preview-test-") && !childPath.startsWith("..") && !isAbsolute(childPath));
    // Windows scanners/loaders can briefly retain a handle after the cache is
    // closed; retry housekeeping without changing any cache assertions.
    rmSync(testDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
