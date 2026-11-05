import test from "node:test";
import assert from "node:assert/strict";
import { appleTrack, baseTitle, CatalogError, isAlternate, isPreviewUrl, loadArtist, normalize, rankAppleTracks, searchArtists, songKey } from "../src/lib/catalog.ts";
import type { Artist, RankingIndex, Track } from "../src/lib/catalog.ts";
import { selectMix } from "../src/lib/rules.ts";

const artist: Artist = { id: "apple:123", name: "Test Artist", image: "", url: "https://music.apple.com/us/artist/123" };
const source = "https://example.org/source-a.csv";
function fixture(count = 30): { tracks: Track[]; data: RankingIndex } {
  const tracks: Track[] = Array.from({ length: count }, (_, index) => ({
    id: `apple:${index + 1000}`, title: `Test Recording ${index}`, aliases: [], artistId: artist.id, artist: artist.name,
    preview: `https://audio-ssl.itunes.apple.com/test-${index}.m4a`, artwork: "", url: `https://music.apple.com/us/song/${index + 1000}`,
    duration: 180 + index, rank: 0,
  }));
  const data: RankingIndex = {
    version: 1, exportedAt: "2026-11-01T00:00:00.000Z", sources: [{ id: "source-a", url: source }], streams: [],
    tracks: tracks.map((track, index) => [`spotify-${index}`, track.title, artist.name, track.duration * 1000, 90 - index, 0, null]),
  };
  return { tracks, data };
}
test("provider ownership requires both exact artist ID and normalized name", () => {
  const item = { kind: "song", artistId: 123, artistName: "Test Artist", trackId: 5000, trackName: "Known Song", collectionName: "An Album", trackTimeMillis: 185000,
    previewUrl: "https://audio-ssl.itunes.apple.com/known.m4a", trackViewUrl: "https://music.apple.com/us/song/5000", artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg" };
  assert.equal(appleTrack(item, artist)?.title, "Known Song");
  assert.equal(appleTrack({ ...item, artistId: 999 }, artist), undefined);
  assert.equal(appleTrack({ ...item, artistName: "A Cover Band" }, artist), undefined);
  assert.equal(appleTrack({ ...item, kind: "music-video" }, artist), undefined);
  assert.equal(appleTrack({ ...item, previewUrl: "https://audio-ssl.itunes.apple.com.evil.example/clip" }, artist), undefined);
  assert.equal(appleTrack({ ...item, trackName: "Known Song (bonus track)" }, artist)?.aliases.includes("Known Song"), true);
});
test("version filtering preserves actual titles while collapsing remasters", () => {
  assert.equal(baseTitle("Known Song (feat. A Guest)"), "Known Song");
  assert.equal(baseTitle("Known Song - 2011 Remaster"), "Known Song");
  assert.equal(songKey("Known Song (Remastered 2011)", artist.name), songKey("Known Song", artist.name));
  for (const title of ["Known Song (Live)", "Known Song - Live at Wembley", "Known Song (Acoustic)", "Known Song - Remix", "Known Song (Taylor's Version)", "Known Song (Karaoke)"]) assert.equal(isAlternate(title), true, title);
  for (const title of ["Live Forever", "Live to Tell", "Cover Me", "Known Song - 2011 Remaster"]) assert.equal(isAlternate(title), false, title);
  assert.equal(normalize("Beyoncé & Friends"), "beyonce and friends");
});
test("preview allowlist only accepts secure provider domains", () => {
  assert.equal(isPreviewUrl("https://audio-ssl.itunes.apple.com/clip.m4a"), true);
  assert.equal(isPreviewUrl("https://cdnt-preview.dzcdn.net/clip.mp3"), true);
  for (const url of ["http://audio-ssl.itunes.apple.com/a", "https://example.com/a", "https://audio-ssl.itunes.apple.com.evil/a", "file:///tmp/audio", "https://secret@audio-ssl.itunes.apple.com/a"]) assert.equal(isPreviewUrl(url), false);
});
test("matching rejects wrong durations, unknown popularity and namesake artists", () => {
  const { tracks, data } = fixture();
  const pool = rankAppleTracks(artist, [...tracks, { ...tracks[0], id: "bad-time", title: "Unknown Recording" }, { ...tracks[1], id: "wrong-artist", artistId: "apple:999" }, { ...tracks[2], id: "duplicate-edition" }], data);
  assert.equal(pool.tracks.length, 30);
  assert.equal(pool.ranking.kind, "catalog-popularity");
  assert.match(pool.ranking.asOf, /Historical; exported/);
  assert.equal(pool.tracks.some(track => track.rank <= 0), false);
  assert.equal(pool.tracks.some(track => track.id === "wrong-artist" || track.id === "bad-time"), false);
  const fewer = rankAppleTracks(artist, tracks.map((track, index) => index === 0 ? { ...track, duration: track.duration + 3 } : track), data);
  assert.equal(fewer.tracks.length, 29);
  assert.equal(fewer.tracks.some(track => track.title === tracks[0].title), false);
});
test("whole pool stream ranking uses one dated source and preserves 6/3/1 selection", () => {
  const { tracks, data } = fixture();
  const streamUrl = "https://kworb.net/spotify/artist/123_songs.html";
  data.streams = tracks.map((track, index) => [track.title, artist.name, track.duration * 1000, 1_000_000 - index * 1000, "2026-10-31", streamUrl]);
  const pool = rankAppleTracks(artist, tracks, data);
  assert.equal(pool.ranking.kind, "streams"); assert.equal(pool.ranking.asOf, "2026-10-31"); assert.equal(pool.ranking.sourceUrl, streamUrl);
  assert.equal(pool.tracks[0].rank, 1_000_000);
  const mix = selectMix(pool.tracks, [], "catalog-integration");
  assert.equal(mix.filter(item => item.tier === "hit").length, 6);
  assert.equal(mix.filter(item => item.tier === "favorite").length, 3);
  assert.equal(mix.filter(item => item.tier === "deep").length, 1);
});
test("partial hits-only stream coverage never assigns missing values to niche tier", () => {
  const { tracks, data } = fixture();
  data.streams = tracks.slice(0, 10).map((track, index) => [track.title, artist.name, track.duration * 1000, 1_000_000 - index * 1000, "2026-10-31", "https://kworb.net/spotify/songs.html"]);
  const pool = rankAppleTracks(artist, tracks, data);
  assert.equal(pool.ranking.kind, "catalog-popularity");
  assert.equal(pool.tracks.length, 30); assert.equal(pool.tracks[0].rank, 90);
});
test("a broad counted pool can exclude a small number of unmeasured songs", () => {
  const { tracks, data } = fixture(25);
  data.streams = tracks.slice(0, 23).map((track, index) => [track.title, artist.name, track.duration * 1000, 1_000_000 - index * 1000, "2026-10-31", "https://kworb.net/spotify/artist/123_songs.html"]);
  const pool = rankAppleTracks(artist, tracks, data);
  assert.equal(pool.ranking.kind, "streams"); assert.equal(pool.tracks.length, 23);
  assert.equal(pool.tracks.some(track => track.id === tracks[24].id), false);
});
test("mixed-source fallback is explicitly labelled and never fakes count provenance", () => {
  const { tracks, data } = fixture(24);
  data.sources.push({ id: "source-b", url: "https://example.org/source-b.csv" });
  data.tracks = data.tracks.map((row, index) => { row[5] = index < 12 ? 0 : 1; return row; });
  const pool = rankAppleTracks(artist, tracks, data);
  assert.equal(pool.ranking.kind, "catalog-popularity"); assert.match(pool.ranking.label, /mixed dates/);
  assert.match(pool.ranking.label, /not play counts/); assert.equal(pool.tracks.length, 24);
});
test("full artist count pages rank previously unknown catalog songs with honest title-only provenance", () => {
  const { tracks, data } = fixture(70); data.tracks = [];
  data.fullStreams = tracks.map((track, index) => [track.title, artist.name, 1_000_000 - index * 1000, "2026-10-31", "https://kworb.net/spotify/artist/123_songs.html", `spotify-${index}`]);
  const pool = rankAppleTracks(artist, tracks, data);
  assert.equal(pool.tracks.length, 70); assert.equal(pool.ranking.kind, "streams");
  assert.equal(pool.tracks.every(track => track.rankMatch === "artist-title"), true);
  assert.equal(pool.tracks[0].rank, 1_000_000);
});
test("full artist count matching excludes ambiguous source titles, edition lengths and invalid counts", () => {
  const { tracks, data } = fixture(); data.tracks = [];
  const streamUrl = "https://kworb.net/spotify/artist/123_songs.html";
  data.fullStreams = tracks.map((track, index) => [track.title, artist.name, 1_000_000 - index * 1000, "2026-10-31", streamUrl, `spotify-${index}`]);
  data.fullStreams.push([tracks[0].title, artist.name, 12345, "2026-10-31", streamUrl, "different-recording"]);
  data.fullStreams[2][2] = 0; data.fullStreams[3][2] = -12;
  const pool = rankAppleTracks(artist, [...tracks, { ...tracks[1], id: "other-edition", duration: tracks[1].duration + 20 }], data);
  assert.equal(pool.tracks.length, 26);
  for (const track of tracks.slice(0, 4)) assert.equal(pool.tracks.some(candidate => candidate.title === track.title), false);
});
test("small or unrankable artist catalogs fail honestly", () => {
  const { tracks, data } = fixture(19);
  assert.throws(() => rankAppleTracks(artist, tracks, data), (error: unknown) => error instanceof CatalogError && error.code === "insufficient_catalog");
  const tied = fixture(); tied.data.tracks.forEach(row => { row[4] = 50; });
  assert.throws(() => rankAppleTracks(artist, tied.tracks, tied.data), /at least 20/);
});
test("invalid provider IDs and excessive queries fail before any network request", async () => {
  await assert.rejects(loadArtist("../../secrets"), /Choose an artist/);
  await assert.rejects(loadArtist("apple:0"), /Choose an artist/);
  await assert.rejects(searchArtists("x"), /between 2 and 80/);
  await assert.rejects(searchArtists("x".repeat(81)), /between 2 and 80/);
});
