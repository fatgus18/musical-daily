import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArtistPortrait, parseAppleArtistPortrait } from "../src/lib/artist-image.ts";
import { loadArtist, type Artist, type ArtistPool } from "../src/lib/catalog.ts";
import { metadataCache } from "../src/lib/provider-cache.ts";

const artist: Artist = { id: "apple:123", name: "Beyoncé & Friends", image: "", url: "https://music.apple.com/us/artist/beyonce-and-friends/123?uo=4" };
const image = "https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages123/v4/portrait/486x486bb.png";
function page(overrides: Record<string, unknown> = {}): string {
  return `<script type="application/ld+json">${JSON.stringify({ "@type": "MusicGroup", name: "Beyonce and Friends", url: artist.url, image, ...overrides })}</script>`;
}

test("artist portraits require the exact provider identity and a genuine artist image", () => {
  assert.deepEqual(parseAppleArtistPortrait(page(), artist), { image, imageSourceUrl: artist.url.split("?")[0], imageAttribution: "Apple Music" });
  for (const overrides of [
    { "@type": "MusicAlbum" }, { name: "Different Artist" },
    { url: "https://music.apple.com/us/artist/beyonce-and-friends/999" },
    { url: "https://music.apple.com.evil.example/us/artist/123" },
    { url: "https://music.apple.com/us/album/123" },
    { image: image.replace("AMCArtistImages123", "Music123") },
    { image: image.replace("is1-ssl.mzstatic.com", "is1-ssl.mzstatic.com.evil.example") },
    { image: image.replace("https:", "http:") },
    { image: image.replace("https://", "https://secret@") },
  ]) assert.equal(parseAppleArtistPortrait(page(overrides), artist), undefined, JSON.stringify(overrides));
  assert.equal(parseAppleArtistPortrait(`<meta property="og:image" content="${image}">`, artist), undefined);
  assert.equal(parseAppleArtistPortrait(page(), { ...artist, url: "https://example.com/123" }), undefined);
});

test("malformed provider data fails closed while a later valid profile can still parse", () => {
  assert.equal(parseAppleArtistPortrait('<script type="application/ld+json">broken</script>', artist), undefined);
  assert.equal(parseAppleArtistPortrait(page().replace('"MusicGroup"', '"MusicAlbum"') + page(), artist)?.image, image);
  assert.equal(parseAppleArtistPortrait(" ".repeat(4_000_001), artist), undefined);
});

test("legacy Features portraits need an identity-matched artist-header circle image", () => {
  const legacyImage = image.replace("AMCArtistImages123", "Features125");
  const header = { id: "123", title: artist.name,
    contentDescriptor: { kind: "artist", identifiers: { storeAdamID: "123" }, url: artist.url },
    circleArtwork: { dictionary: { url: legacyImage.replace("486x486bb.png", "{w}x{h}{c}.{f}") } } };
  const serialized = (item: unknown, itemKind = "artistDetailHeader") => `<script type="application/json" id="serialized-server-data">${JSON.stringify({ data: [{ data: { sections: [{ itemKind, items: [item] }] } }] })}</script>`;
  assert.equal(parseAppleArtistPortrait(page({ image: legacyImage }), artist), undefined, "Generic schema Features images alone are not proof of an artist portrait");
  assert.equal(parseAppleArtistPortrait(serialized(header), artist)?.image, legacyImage);
  for (const changed of [
    { ...header, id: "999" }, { ...header, title: "A Namesake" },
    { ...header, contentDescriptor: { ...header.contentDescriptor, kind: "album" } },
    { ...header, contentDescriptor: { ...header.contentDescriptor, identifiers: { storeAdamID: "999" } } },
    { ...header, circleArtwork: undefined, artwork: header.circleArtwork },
    { ...header, circleArtwork: { dictionary: { url: legacyImage.replace("Features125", "Music125") } } },
  ]) assert.equal(parseAppleArtistPortrait(serialized(changed), artist), undefined);
  assert.equal(parseAppleArtistPortrait(serialized(header, "playlist"), artist), undefined);
});

test("cached catalogs replace album covers with profile portraits without discography refetches", async () => {
  const originalFetch = globalThis.fetch; const originalPath = process.env.ENCORE_CATALOG_CACHE_PATH;
  process.env.ENCORE_CATALOG_CACHE_PATH = join(mkdtempSync(join(tmpdir(), "encore-portraits-")), "cache.sqlite");
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    assert.equal(new URL(String(input)).hostname, "music.apple.com");
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  try {
    const pool: ArtistPool = { artist: { ...artist, image: "https://is1-ssl.mzstatic.com/image/thumb/Music123/album/600x600bb.jpg" },
      tracks: [], fetchedAt: Date.now(), ranking: { kind: "unranked", label: "Discovery", sourceUrl: artist.url, asOf: "2026-11-01" } };
    metadataCache().put(`live-v1:pool:${artist.id}`, pool, 60_000);
    const upgraded = await loadArtist(artist.id);
    assert.equal(upgraded.artist.image, image); assert.equal(upgraded.artist.imageAttribution, "Apple Music");
    assert.equal((await loadArtist(artist.id)).artist.image, image);
    assert.equal(calls.length, 1, "The portrait and old song pool both reuse bounded caches");
    assert.ok(metadataCache().stats().bytes < 10_000, "Only metadata is cached, never image binaries");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.ENCORE_CATALOG_CACHE_PATH; else process.env.ENCORE_CATALOG_CACHE_PATH = originalPath;
  }
});

test("unavailable portraits use a negative cache and never fall back to an album cover", async () => {
  const originalFetch = globalThis.fetch; const originalPath = process.env.ENCORE_CATALOG_CACHE_PATH;
  process.env.ENCORE_CATALOG_CACHE_PATH = join(mkdtempSync(join(tmpdir(), "encore-portrait-missing-")), "cache.sqlite");
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("Unavailable", { status: 503 }); }) as typeof fetch;
  try {
    const pool: ArtistPool = { artist: { ...artist, image: "https://is1-ssl.mzstatic.com/image/thumb/Music123/album/600x600bb.jpg" },
      tracks: [], fetchedAt: Date.now(), ranking: { kind: "unranked", label: "Discovery", sourceUrl: artist.url, asOf: "2026-11-01" } };
    metadataCache().put(`live-v1:pool:${artist.id}`, pool, 60_000);
    assert.equal((await loadArtist(artist.id)).artist.image, "");
    assert.equal(await loadArtistPortrait(artist), undefined);
    assert.equal(calls, 1);
    assert.equal(await loadArtistPortrait({ ...artist, id: "apple:999" }), undefined);
    assert.equal(calls, 1, "Mismatched IDs never trigger an outgoing request");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.ENCORE_CATALOG_CACHE_PATH; else process.env.ENCORE_CATALOG_CACHE_PATH = originalPath;
  }
});
