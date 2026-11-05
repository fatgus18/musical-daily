import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { safeArtworkUrl, alternateSpotifyArtwork, reviewedLegacyArtwork } from "../src/lib/artwork";
import { isMatchingRecording } from "../src/lib/preview-matching";
import legacyArtwork from "../data/legacy-artwork.json";

test("artwork allows both official Spotify CDNs and Apple while rejecting impostor hosts", () => {
  for (const url of ["https://i.scdn.co/image/album", "https://image-cdn-ak.spotifycdn.com/image/album", "https://image-cdn-fa.spotifycdn.com/image/album", "https://is1-ssl.mzstatic.com/image/album.jpg"]) assert.equal(safeArtworkUrl(url), url);
  for (const url of ["http://i.scdn.co/image/a", "https://i.scdn.co.evil.test/image/a", "https://evilspotifycdn.com/image/a", "https://image-cdn-ak.spotifycdn.com.evil.test/image/a", "https://user:password@i.scdn.co/image/a", "https://i.scdn.co:444/image/a"]) assert.equal(safeArtworkUrl(url), undefined);
  assert.equal(alternateSpotifyArtwork("https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e029e2f95ae77cf436017ada9cb"), "https://i.scdn.co/image/ab67616d00001e029e2f95ae77cf436017ada9cb");
  assert.equal(alternateSpotifyArtwork("https://is1-ssl.mzstatic.com/image/album.jpg"), undefined);
});

test("every production and historical recording has a persisted real cover without changing catalog releases", () => {
  const index = JSON.parse(readFileSync(resolve("data/catalog-releases.json"), "utf8")) as { releases: { version: string }[] };
  const artwork = JSON.parse(readFileSync(resolve("data/artwork.json"), "utf8"));
  assert.equal(artwork.schema, 1);
  for (const release of index.releases) {
    const catalog = JSON.parse(readFileSync(resolve("data/catalog-releases", `${release.version}.json`), "utf8"));
    for (const track of catalog.tracks) assert.ok(safeArtworkUrl(artwork.tracks[track.id]?.url), `${track.artist} — ${track.title} has a published cover`);
  }
});

test("reviewed legacy artwork is scoped to exact historical records without relaxing preview identity", () => {
  const legacy = JSON.parse(readFileSync(resolve("data/catalog-releases/cc7938fda738.json"), "utf8"));
  const current = JSON.parse(readFileSync(resolve("data/catalog-releases/943b8016d58869da.json"), "utf8"));
  assert.equal(legacyArtwork.tracks.length, 4);
  for (const review of legacyArtwork.tracks) {
    const track = legacy.tracks.find((item: { id: string }) => item.id === review.id);
    assert.ok(track);
    assert.ok(!current.tracks.some((item: { id: string }) => item.id === review.id));
    assert.equal(reviewedLegacyArtwork(track)?.url, review.url);
    assert.equal(reviewedLegacyArtwork({ ...track, id: "different-id" }), undefined);
    assert.equal(reviewedLegacyArtwork({ ...track, artist: "Cover Band" }), undefined);
    assert.equal(reviewedLegacyArtwork({ ...track, title: `${track.title} (Remix)` }), undefined);
    assert.equal(reviewedLegacyArtwork({ ...track, releaseYear: 2025 }), undefined);
    assert.equal(isMatchingRecording(track, { kind: "song", trackName: review.providerTitle, artistName: review.providerArtists }), false, "artwork-only review never permits ambiguous audio matches");
    assert.match(review.verificationUrl, new RegExp(`id=${review.appleArtistId},${review.appleTrackId}`));
  }
});

test("new Spotify CDN responses are persisted, duplicate requests coalesce and lookup failures retry", async () => {
  // Override only the cache path. Changing cwd can make the TS loader's child
  // process hold the temporary directory open on Windows during cleanup.
  const previousCachePath = process.env.BLACKJACK_ARTWORK_CACHE_PATH;
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(resolve(temporaryRoot, "blackjack-artwork-test-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  let calls = 0;
  let outage = false;
  try {
    process.env.BLACKJACK_ARTWORK_CACHE_PATH = resolve(directory, "data/runtime/artwork-v1.json");
    const { resolveTrackArtwork } = await import(`../src/lib/artwork.ts?isolated=${Date.now()}`);
    Date.now = () => now;
    globalThis.fetch = async () => {
      calls += 1;
      if (outage) return new Response("Busy", { status: 503 });
      return Response.json({ thumbnail_url: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e029e2f95ae77cf436017ada9cb" });
    };
    const track = { id: "fixture", title: "Song", artist: "Artist", releaseYear: 2020, streams: 1 };
    const [one, two] = await Promise.all([resolveTrackArtwork(track), resolveTrackArtwork(track)]);
    assert.equal(one?.url, "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e029e2f95ae77cf436017ada9cb");
    assert.deepEqual(one, two);
    assert.equal(calls, 1);
    assert.ok(readFileSync(resolve(directory, "data/runtime/artwork-v1.json"), "utf8").includes(track.id));
    outage = true;
    assert.deepEqual(await resolveTrackArtwork(track), one, "published/cached artwork survives provider outage");
    assert.equal(calls, 1);
    assert.equal(await resolveTrackArtwork({ ...track, id: "new" }), undefined);
    const afterMiss = calls;
    assert.equal(await resolveTrackArtwork({ ...track, id: "new" }), undefined);
    assert.equal(calls, afterMiss);
    now += 61_000;
    outage = false;
    assert.ok(await resolveTrackArtwork({ ...track, id: "new" }));
    assert.ok(calls > afterMiss, "missing covers are not cached permanently");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (previousCachePath === undefined) delete process.env.BLACKJACK_ARTWORK_CACHE_PATH;
    else process.env.BLACKJACK_ARTWORK_CACHE_PATH = previousCachePath;
    const child = relative(temporaryRoot, directory);
    assert.ok(child.startsWith("blackjack-artwork-test-") && !child.startsWith("..") && !isAbsolute(child));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
