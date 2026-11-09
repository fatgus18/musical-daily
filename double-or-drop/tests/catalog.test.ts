import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadCatalog, catalogStatus, listThemes, listArtistThemes, filterCatalog, validateTrack, validateCatalog, catalogVersion, eligibleThemeMetric } from "../src/lib/catalog.ts";
import { applyStreamRows, parseStreamPage, mergeFeed, publishCatalog, pruneCatalogs, importDatabase, mergeSharedRefresh } from "../scripts/catalog-refresh.ts";
import type { Catalog, CatalogTrack } from "../src/lib/catalog-types.ts";
import { artistPoolTracks } from "../src/lib/catalog-artists.ts";
import { isPreviewUrl } from "../src/lib/catalog.ts";
import type { ArtistPool } from "../../shared/music-provider/catalog.ts";
import { DatabaseSync } from "node:sqlite";

test("a two-song artist is available when its displayed answers differ, with no twelve-song barrier", () => {
  const template = loadCatalog().tracks[0];
  const tracks: CatalogTrack[] = [100, 120].map((value, i) => ({ ...template, id: `small-${i}`, title: `Different song ${i}`, artist: "Small artist", primaryArtist: "Small artist", metrics: { duration: { value, sourceUrl: template.sourceUrl } } }));
  assert.equal(eligibleThemeMetric(tracks, "duration"), true);
  assert.equal(listArtistThemes({ ...loadCatalog(), tracks }).length, 1);
  tracks[1].title = tracks[0].title;
  assert.equal(eligibleThemeMetric(tracks, "duration"), false, "edition duplicates cannot make a fake artist collection");
});

test("current Tempo and Blackjack published collections are all reused without a popularity cut", async () => {
  const ids = new Set(loadCatalog().tracks.map(track => track.id));
  for (const app of ["tempo-trap", "blackjack-music"]) {
    const directory = resolve(process.cwd(), "..", app, "data");
    const index = JSON.parse(await readFile(resolve(directory, "catalog-releases.json"), "utf8"));
    const published = JSON.parse(await readFile(resolve(directory, "catalog-releases", `${index.releases.at(-1).version}.json`), "utf8"));
    assert.deepEqual(published.tracks.filter((track: { id: string }) => !ids.has(track.id)).map((track: { id: string }) => track.id), [], app);
  }
});

test("database adapter includes zero-popularity recordings and alternate versions with sourced measurements", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "drop-source-"));
  const path = resolve(directory, "music.sqlite"); const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE tracks(id TEXT,title TEXT,artist TEXT,primary_artist TEXT,duration_ms INTEGER,bpm REAL,bpm_source TEXT,bpm_quality TEXT,source TEXT,genre TEXT,popularity INTEGER,language TEXT,language_review_required INTEGER); CREATE TABLE media(track_id TEXT,artwork_url TEXT,purchase_url TEXT,preview_url TEXT,status TEXT,duration_ms INTEGER); CREATE TABLE stream_snapshots(track_id TEXT,streams INTEGER,source TEXT,observed_on TEXT);`);
  const insert = db.prepare("INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("source-one", "Song - Live", "Artist", "Artist", 100000, 100, "spotify-features-114k", "estimated", "spotify-features-114k", "rock", 0, "en", 0);
  insert.run("source-two", "Song Two", "Artist", "Artist", 120000, 120, "spotify-features-114k", "estimated", "spotify-features-114k", "rock", 1, "en", 0);
  insert.run("needs-review", "Review", "Artist", "Artist", 120000, 120, "spotify-features-114k", "estimated", "spotify-features-114k", "rock", 99, "en", 1);
  db.close();
  try { assert.deepEqual(importDatabase(path).map(track => track.id), ["source-one", "source-two"]); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("live Encore discovery keeps every owned recording, preview and unranked duration without inventing streams", () => {
  const artist = { id: "apple:123", name: "An artist", image: "", url: "https://music.apple.com/us/artist/an-artist/123" };
  const tracks = [100, 120, 140].map((duration, i) => ({ id: `apple:${1000 + i}`, title: `Real song ${i}`, artistId: artist.id, artist: artist.name, aliases: [], duration, rank: 0, preview: `https://audio-ssl.itunes.apple.com/example${i}.m4a`, artwork: "", url: `https://music.apple.com/us/album/123?i=${1000 + i}` }));
  const pool: ArtistPool = { artist, tracks: [tracks[0]], discoveryTracks: tracks, ranking: { kind: "unranked", label: "Discovery", sourceUrl: artist.url, asOf: "2026-11-03" }, fetchedAt: Date.now() };
  const result = artistPoolTracks(pool);
  assert.equal(result.length, 3); assert.ok(result.every(track => track.previewUrl && track.previewSourceUrl && !track.metrics.streams && !track.metrics.tempo));
  const foreign = { ...tracks[0], id: "apple:9999", artistId: "apple:456" };
  assert.equal(artistPoolTracks({ ...pool, discoveryTracks: [...tracks, foreign] }).length, 3);
  assert.equal(isPreviewUrl("https://mzstatic.com.evil.example/a.mp3"), false);
  assert.equal(isPreviewUrl("https://user:password@audio-ssl.itunes.apple.com/a.m4a"), false);
});

test("launch catalog contains thousands of real sourced recordings and no invented release years", () => {
  const catalog = loadCatalog(); const status = catalogStatus(catalog);
  assert.ok(status.tracks >= 16000); assert.ok(status.artists >= 4500);
  assert.ok(status.metrics.streams >= 500); assert.ok(status.metrics.duration >= status.tracks - 10);
  assert.ok(catalog.tracks.filter(track => track.metrics.tempo).length >= 16000, "stored tempo metadata remains available for historical results");
  assert.equal(status.metrics.tempo, undefined); assert.equal(status.metrics.year, 0);
  assert.equal(new Set(catalog.tracks.map(track => track.id)).size, status.tracks);
  assert.ok(catalog.tracks.every(track => /^https:\/\/(open\.spotify\.com\/track\/|music\.apple\.com\/)/.test(track.sourceUrl)));
  assert.ok(catalog.tracks.every(track => !track.decade));
  assert.ok(catalog.tracks.some(track => track.title === "Blinding Lights" && track.artist.includes("The Weeknd")));
});

test("themes advertise only metrics with enough distinct comparable answers", () => {
  const catalog = loadCatalog();
  assert.ok(listThemes(catalog).length >= 7);
  const artists = listArtistThemes(catalog);
  assert.ok(artists.length >= 20);
  assert.ok(artists.some(artist => artist.label === "Taylor Swift"));
  for (const theme of [...listThemes(catalog), ...artists]) {
    const tracks = filterCatalog(catalog, theme.id);
    assert.equal(tracks.length, theme.trackCount);
    for (const metric of theme.metrics) {
      assert.notEqual(metric, "tempo", "retired tempo comparisons must not be advertised");
      const answers = tracks.flatMap(track => track.metrics[metric] ? [track.metrics[metric]!.value] : []);
      assert.ok(answers.length >= 2); assert.ok(new Set(answers).size >= 2);
    }
  }
});

test("theme options exclude decimal values that all reveal as the same BPM or duration", () => {
  const template = loadCatalog().tracks[0];
  const tracks: CatalogTrack[] = Array.from({ length: 12 }, (_, index) => ({ ...template, id: `theme-${index}`, title: `Theme song ${index}`, genre: "pop", metrics: {
    tempo: { value: 100.01 + index / 100, sourceUrl: template.sourceUrl },
    duration: { value: 180.01 + index / 100, sourceUrl: template.sourceUrl },
  } }));
  assert.equal(eligibleThemeMetric(tracks, "tempo"), false);
  assert.equal(eligibleThemeMetric(tracks, "duration"), false);
  assert.deepEqual(listThemes({ ...loadCatalog(), tracks }), []);
  for (let index = 0; index < tracks.length; index++) tracks[index].metrics.tempo!.value = 100 + index % 6;
  assert.equal(eligibleThemeMetric(tracks, "tempo"), true);
  assert.deepEqual(listThemes({ ...loadCatalog(), tracks }), [], "unpreviewed tempo measurements do not re-enable the category");
  for (let index = 0; index < tracks.length; index++) tracks[index].metrics.duration!.value = 180 + index % 6;
  assert.deepEqual(listThemes({ ...loadCatalog(), tracks }).find(item => item.id === "pop")?.metrics, ["duration"]);
});

test("stream theme options need enough distinct values within one shared observation date", () => {
  const template = loadCatalog().tracks[0];
  const tracks: CatalogTrack[] = Array.from({ length: 24 }, (_, index) => ({ ...template, id: `stream-${index}`, title: `Stream song ${index}`, genre: "pop", metrics: {
    streams: { value: 1_000_000 + index * 1000, sourceUrl: "https://example.org/observed-streams", asOf: `2026-10-${String(index + 1).padStart(2, "0")}` },
  } }));
  assert.equal(eligibleThemeMetric(tracks, "streams"), false);
  assert.deepEqual(listThemes({ ...loadCatalog(), tracks }), []);
  for (let index = 0; index < 12; index++) tracks[index].metrics.streams!.asOf = "2026-10-01";
  assert.equal(eligibleThemeMetric(tracks, "streams"), true);
  assert.deepEqual(listThemes({ ...loadCatalog(), tracks }).find(item => item.id === "pop")?.metrics, ["streams"]);
  for (let index = 0; index < 12; index++) tracks[index].metrics.streams!.value = 1_000_000;
  assert.equal(eligibleThemeMetric(tracks, "streams"), false);
});

test("validation rejects unsourced counts, edition years, invalid dates and nonfinite values", () => {
  const sample = loadCatalog().tracks.find(track => track.metrics.streams)!;
  assert.throws(() => validateTrack({ ...sample, metrics: { streams: { value: 92, sourceUrl: sample.sourceUrl } } }), /observed count and date/);
  assert.throws(() => validateTrack({ ...sample, metrics: { year: { value: 2000, sourceUrl: sample.sourceUrl, quality: "album-edition-date" } } }), /original-release/);
  assert.throws(() => validateTrack({ ...sample, metrics: { duration: { value: NaN, sourceUrl: sample.sourceUrl } } }), /finite/);
  assert.throws(() => validateTrack({ ...sample, metrics: { streams: { value: 9, sourceUrl: sample.sourceUrl, asOf: "2026-02-30" } } }), /date/);
  assert.throws(() => validateTrack({ ...sample, artwork: "javascript:alert(1)" }), /HTTPS/);
  assert.throws(() => loadCatalog("../outside"), /version/);
});

test("published metadata hashes detect changed answers", () => {
  const catalog: Catalog = structuredClone(loadCatalog());
  catalog.tracks[0].metrics.duration!.value += 1;
  assert.throws(() => validateCatalog(catalog), /immutable/);
  catalog.version = catalogVersion(catalog.tracks, catalog.sources);
  validateCatalog(catalog);
});

test("stream provider parser checks the Streams header and decodes recording names", () => {
  const rows = parseStreamPage('<table><thead><tr><th>Song</th><th>Streams</th></tr></thead><tbody><tr><td><a>Artist &amp; Friend - Song</a></td><td>1,234,567</td></tr></tbody></table>');
  assert.deepEqual(rows, [{ artist: "Artist & Friend", title: "Song", streams: 1234567 }]);
  assert.throws(() => parseStreamPage('<table><th>Views</th></table>'), /format changed/);
});

test("stream refresh updates existing evidenced identities, preserving misses and rejecting ambiguous totals", () => {
  const catalog = loadCatalog(); const track = catalog.tracks.find(item => item.metrics.streams)!;
  const unknown = catalog.tracks.find(item => !item.metrics.streams)!;
  const rows = [{ artist: track.primaryArtist || track.artist, title: track.title, streams: 123456 }, { artist: unknown.primaryArtist || unknown.artist, title: unknown.title, streams: 234567 }];
  const result = applyStreamRows([track, unknown], rows, "2026-11-02");
  assert.equal(result.updated, 1); assert.equal(result.tracks[0].metrics.streams!.value, 123456);
  assert.equal(result.tracks[1], unknown); assert.equal(track.metrics.streams!.value === 123456, false);
  const ambiguous = applyStreamRows([track], [...rows, { ...rows[0], streams: 333333 }], "2026-11-02");
  assert.equal(ambiguous.updated, 0); assert.equal(ambiguous.tracks[0], track);
});

test("shared refresh keeps published provider songs after cache expiry without reviving excluded bulk rows", () => {
  const template = loadCatalog().tracks.find(track => track.metrics.streams)!;
  const provider = { ...template, id: "apple:123456" };
  const excludedBulk = { ...template, id: "excluded-bulk-recording" };
  const imported = { ...template, metrics: { ...template.metrics, streams: { ...template.metrics.streams!, asOf: "2026-01-01", value: 1 } } };
  const output = mergeSharedRefresh([imported], [template, provider, excludedBulk]);
  assert.deepEqual(output.map(track => track.id), [template.id, provider.id]);
  assert.equal(output[0].metrics.streams!.asOf, template.metrics.streams!.asOf);
  assert.equal(output[1], provider);
});

test("feeds require language evidence and reject duplicates transactionally", () => {
  const catalog = loadCatalog(); const track = catalog.tracks[0]; const sources = catalog.sources;
  assert.throws(() => mergeFeed([track], { tracks: [{ ...track }], sources }), /English/);
  assert.throws(() => mergeFeed([track], { tracks: [{ ...track, language: "en" }], sources }), /languageSource/);
  const valid = { ...track, language: "en", languageSource: "https://example.org/recording-language" };
  assert.throws(() => mergeFeed([track], { tracks: [valid, valid], sources }), /Duplicate/);
  assert.equal(mergeFeed([track], { tracks: [valid], sources }).tracks.length, 1);
  const differentId = { ...valid, id: "replacement-recording" };
  assert.equal(mergeFeed([track], { tracks: [differentId], sources }).tracks.length, 1);
});

test("publication preserves old runs and only switches the pointer after valid immutable output", async () => {
  const path = await mkdtemp(resolve(tmpdir(), "double-drop-catalog-"));
  try {
    const original = loadCatalog(); const first = await publishCatalog(original.tracks, original.sources, path);
    const firstBytes = await readFile(resolve(path, "catalog-releases", `${first.version}.json`), "utf8");
    const tracks: CatalogTrack[] = structuredClone(original.tracks); tracks[0].metrics.duration!.value += 1;
    const second = await publishCatalog(tracks, original.sources, path);
    assert.notEqual(first.version, second.version);
    assert.equal(await readFile(resolve(path, "catalog-releases", `${first.version}.json`), "utf8"), firstBytes);
    assert.equal(JSON.parse(await readFile(resolve(path, "catalog-releases.json"), "utf8")).current, second.version);
    const artistPack = await publishCatalog(tracks.filter(track => track.primaryArtist === "Hozier"), original.sources, path, false);
    assert.notEqual(artistPack.version, second.version);
    assert.equal(JSON.parse(await readFile(resolve(path, "catalog-releases.json"), "utf8")).current, second.version, "artist selection must not replace the entire public library");
    await assert.rejects(publishCatalog([{ ...tracks[0], metrics: {} }], original.sources, path));
    assert.equal(JSON.parse(await readFile(resolve(path, "catalog-releases.json"), "utf8")).current, second.version);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("retention preserves referenced versions, current pointer and recent rollback releases", async () => {
  const path = await mkdtemp(resolve(tmpdir(), "double-drop-retention-"));
  try {
    await mkdir(resolve(path, "catalog-releases"));
    const versions = Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(16, "0"));
    for (let index = 0; index < versions.length; index++) {
      const file = resolve(path, "catalog-releases", `${versions[index]}.json`);
      await writeFile(file, "{}"); const date = new Date(Date.UTC(2020, 0, index + 1)); await utimes(file, date, date);
    }
    await writeFile(resolve(path, "catalog-releases.json"), JSON.stringify({ current: versions[1] }));
    assert.equal(await pruneCatalogs([versions[0]], path), 1);
    const retained = await readdir(resolve(path, "catalog-releases"));
    assert.ok(retained.includes(`${versions[0]}.json`)); assert.ok(retained.includes(`${versions[1]}.json`));
    assert.ok(!retained.includes(`${versions[2]}.json`));
    await assert.rejects(pruneCatalogs(["invalid-version"], path), /saved-run version/);
  } finally { await rm(path, { recursive: true, force: true }); }
});
