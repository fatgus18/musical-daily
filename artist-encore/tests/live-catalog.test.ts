import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetadataCache } from "../src/lib/provider-cache.ts";
import { parseArtistDirectory, parseArtistStreams } from "../src/lib/stream-provider.ts";
import { appleTrack, distinctRecordings, loadArtist, releaseBatch, songKey } from "../src/lib/catalog.ts";
import type { Artist, Track } from "../src/lib/catalog.ts";
import { answerMatches } from "../src/lib/rules.ts";
import { boundedResponseText } from "../src/lib/provider-http.ts";

const artist: Artist = { id: "apple:123", name: "No Chart Artist", image: "", url: "https://music.apple.com/us/artist/123" };
function track(title: string, id = 1): Track {
  return { id: `apple:${id}`, title, artist: artist.name, artistId: artist.id, aliases: [title], rank: 0, duration: 180,
    preview: "https://audio-ssl.itunes.apple.com/test.m4a", artwork: "", url: "https://music.apple.com/us/song/123" };
}
test("metadata cache evicts by bytes and keys, bounds stale recovery and coordinates provider slots", () => {
  const file = join(mkdtempSync(join(tmpdir(), "encore-cache-")), "cache.sqlite");
  const cache = new MetadataCache(file, { maxBytes: 100, maxEntries: 2, maxEntryBytes: 80 });
  const now = Date.now();
  try {
    cache.put("a", "a".repeat(40), 100, 100, now);
    cache.put("b", "b".repeat(40), 100, 100, now + 1);
    cache.put("c", "c".repeat(40), 100, 100, now + 2);
    assert.equal(cache.get("a", true, now + 3), undefined);
    assert.ok(cache.stats().bytes <= 100); assert.equal(cache.stats().entries, 2);
    cache.put("too-large", "z".repeat(90), 100, 100, now);
    assert.equal(cache.get("too-large", true, now), undefined);
    assert.equal(cache.get("c", false, now + 103), undefined);
    assert.equal(cache.get("c", true, now + 103)?.stale, true);
    assert.equal(cache.get("c", true, now + 203), undefined);
    assert.equal(cache.reserve("apple", 3200, 5000, now), 0);
    assert.equal(cache.reserve("apple", 3200, 5000, now), 3200);
    assert.equal(cache.reserve("apple", 3200, 5000, now), undefined);
  } finally { cache.close(); }
});

test("stream parser verifies identity and date, excludes guest credits and missing counts", () => {
  const spotifyId = "a".repeat(22);
  const source = "https://kworb.net/spotify/artist/aaaaaaaaaaaaaaaaaaaaaa_songs.html";
  const row = (title: string, count: string) => `<tr><td><a href="https://open.spotify.com/track/${spotifyId}">${title}</a></td><td>${count}</td></tr>`;
  const html = `<title>No Chart Artist - Spotify Top Songs</title>Last updated: 2026/10/31<table><tr><th>Song Title</th><th>Streams</th></tr>${row("A &amp; B", "1,234")}${row("* Guest", "456")}${row("Unmeasured", "0")}${row("Invalid", "-1")}</table>`;
  const parsed = parseArtistStreams(html, artist.name, source);
  assert.deepEqual(parsed.observations, [{ title: "A & B", streams: 1234, spotifyId }]);
  assert.equal(parsed.asOf, "2026-10-31");
  assert.throws(() => parseArtistStreams(html, "Namesake", source), /identity/);
  assert.throws(() => parseArtistStreams(html.replace("2026/10/31", "2026/02/31"), artist.name, source), /date/);
  assert.deepEqual(parseArtistDirectory('<a href="artist/aaaaaaaaaaaaaaaaaaaaaa.html">A &amp; B</a>'), [{ id: spotifyId, name: "A & B" }]);
});
test("provider response limits apply while reading chunked bodies and count UTF-8 bytes", async () => {
  assert.equal(await boundedResponseText(new Response("Beyoncé"), 8), "Beyoncé");
  await assert.rejects(boundedResponseText(new Response("Beyoncé"), 7), /too large/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedResponseText(new Response(body), 12), /too large/);
  assert.equal(cancelled, true);
});

test("official live-only originals survive while duplicate studio/live, remaster and Part/Pt editions collapse", () => {
  const raw = { kind: "song", artistId: 123, artistName: artist.name, trackId: 9, trackName: "Cherry Wine (Live)", collectionName: "An Album", trackTimeMillis: 180000,
    previewUrl: "https://audio-ssl.itunes.apple.com/test.m4a", trackViewUrl: "https://music.apple.com/us/song/9" };
  const live = appleTrack(raw, artist)!;
  assert.equal(live.version, "live");
  const mixed = distinctRecordings([live, { ...track("Known (Live)", 2), version: "live" }, track("Known", 3), track("De Selby (Part 1)", 4), track("De Selby (Pt. 1)", 5)]);
  assert.equal(mixed.length, 3);
  assert.equal(mixed.some(item => item.title === "Cherry Wine (Live)"), true);
  assert.equal(mixed.some(item => item.title === "Known (Live)"), false);
  assert.equal(answerMatches(mixed.find(item => item.title.startsWith("De Selby"))!, "De Selby (Part 1)"), true);
  assert.equal(answerMatches(mixed.find(item => item.title.startsWith("De Selby"))!, "De Selby (Pt. 1)"), true);
  assert.equal(answerMatches(mixed.find(item => item.title.startsWith("Cherry Wine"))!, "Cherry Wine"), true);
  assert.equal(songKey("De Selby (Part 1)", artist.name), songKey("De Selby (Pt. 1)", artist.name));
  assert.equal(appleTrack({ ...raw, trackName: "Known (Karaoke)" }, artist), undefined);
  assert.equal(appleTrack({ ...raw, trackName: "Known (A Choral Version)" }, artist), undefined);
});

test("release batching includes EPs/singles/bonus editions and keeps result requests bounded", () => {
  const releases = Array.from({ length: 25 }, (_, i) => ({ id: `${i + 1}`, name: `Edition ${i}`, trackCount: i === 1 ? 1 : 20 }));
  const first = releaseBatch(releases, 0);
  assert.ok(first.some(item => item.trackCount === 1));
  assert.ok(first.reduce((sum, item) => sum + item.trackCount + 1, 0) <= 180);
  assert.equal(first.length <= 10, true);
  assert.equal(releaseBatch(releases, first.length)[0].id, releases[first.length].id);
});

test("live discovery traverses every returned release, resumes failures and refreshes after six hours without a ranking export", { timeout: 90_000 }, async () => {
  const originalFetch = globalThis.fetch; const originalPath = process.env.ENCORE_CATALOG_CACHE_PATH;
  const originalNow = Date.now;
  process.env.ENCORE_CATALOG_CACHE_PATH = join(mkdtempSync(join(tmpdir(), "encore-live-")), "cache.sqlite");
  const providerArtist = { wrapperType: "artist", artistId: 123, artistName: artist.name, artistLinkUrl: artist.url };
  const releases = Array.from({ length: 41 }, (_, i) => ({ wrapperType: "collection", collectionId: 1000 + i, collectionName: i === 40 ? "New Bonus EP" : `Release ${i}`, artistId: 123, artistName: artist.name, trackCount: i === 40 ? 2 : 20 }));
  const requested = new Set<number>();
  let failOnce = false;
  let artistLookups = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "music.apple.com") return new Response("No artist portrait available", { status: 404 });
    if (url.hostname === "kworb.net") return new Response(Array.from({ length: 101 }, (_, i) => `<a href="artist/${String(i).padStart(22, "a")}.html">Other Artist ${i}</a>`).join(""));
    const ids = (url.searchParams.get("id") || "").split(",").map(Number);
    if (ids[0] === 123) { artistLookups++; return Response.json({ results: url.searchParams.get("entity") === "album" ? [providerArtist, ...releases] : [providerArtist] }); }
    if (failOnce) { failOnce = false; return Response.json({}, { status: 429 }); }
    const results: object[] = [];
    for (const id of ids) {
      requested.add(id); const release = releases.find(item => item.collectionId === id)!; results.push(release);
      for (let i = 0; i < release.trackCount; i++) results.push({ ...release, wrapperType: "track", kind: "song", trackId: id * 100 + i,
        trackName: `Song ${id} ${i}`, trackTimeMillis: 180000, previewUrl: `https://audio-ssl.itunes.apple.com/${id}-${i}.m4a`, trackViewUrl: `https://music.apple.com/us/song/${id * 100 + i}` });
    }
    return Response.json({ results });
  }) as typeof fetch;
  try {
    assert.equal(existsSync(resolve("data/ranking-index.json")), false);
    const first = await loadArtist("apple:123");
    assert.equal(first.ranking.kind, "unranked");
    assert.equal(first.coverage?.status, "partial"); assert.equal(first.coverage?.hasMore, true);
    assert.equal(first.coverage?.loadedReleases, 32);
    assert.equal(first.tracks.every(item => item.rank === 0), true);
    failOnce = true;
    const interrupted = await loadArtist("apple:123", { continue: true });
    assert.equal(interrupted.coverage?.loadedReleases, 32);
    assert.equal(interrupted.coverage?.hasMore, true);
    assert.match(interrupted.coverage?.message || "", /busy/);
    const completed = await loadArtist("apple:123", { continue: true });
    assert.equal(completed.coverage?.status, "complete"); assert.equal(completed.coverage?.hasMore, false);
    assert.equal(completed.coverage?.loadedReleases, 41); assert.equal(requested.size, 41);
    assert.equal(completed.discoveryTracks?.length, 802);
    assert.ok(completed.discoveryTracks?.some(item => item.title === "Song 1040 1"));
    const lookupsBeforeRefresh = artistLookups;
    Date.now = () => originalNow() + 6 * 3600_000 + 1000;
    const renewed = await loadArtist("apple:123");
    assert.ok(artistLookups >= lookupsBeforeRefresh + 2, "Completed unranked catalogs must discover new releases after six hours");
    assert.equal(renewed.coverage?.loadedReleases, 32);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; if (originalPath === undefined) delete process.env.ENCORE_CATALOG_CACHE_PATH; else process.env.ENCORE_CATALOG_CACHE_PATH = originalPath; }
});
