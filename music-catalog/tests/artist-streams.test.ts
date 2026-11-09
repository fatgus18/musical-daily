import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, trackWriter, type Track } from "../src/store.ts";
import { saveArtistStreams } from "../src/artist-streams.ts";

const recording: Omit<Track, "recording_key"> = { id: "0VjIjW4GlUZAMYd2vXMi3b", title: "Blinding Lights", artist: "The Weeknd", primary_artist: "The Weeknd", album: "After Hours", duration_ms: 200000, release_date: "2019", popularity: 90, language: "en", language_source: "manual-reviewed", bpm: 171, bpm_source: "review", bpm_quality: "reviewed", genre: "pop", source: "test", instrumentalness: 0 };
const observation = { artist: "The Weeknd", asOf: "2026-11-08", sourceUrl: "https://kworb.net/spotify/artist/example_songs.html", observations: [{ spotifyId: recording.id, title: recording.title, streams: 5000000000 }] };

test("artist stream import preserves provider URL/date and is idempotent", () => {
  const db = openStore(":memory:");
  try {
    trackWriter(db)(recording);
    assert.equal(saveArtistStreams(db, observation, "2026-11-09"), 1);
    saveArtistStreams(db, observation, "2026-11-09");
    const rows = db.prepare("SELECT * FROM stream_snapshots").all();
    assert.equal(rows.length, 1); assert.equal(rows[0].source, observation.sourceUrl);
    assert.equal(rows[0].observed_on, observation.asOf); assert.equal(rows[0].match_method, "exact-spotify-id + artist-title");
  } finally { db.close(); }
});

test("artist stream import refuses contradictory IDs and stale or future dates", () => {
  const db = openStore(":memory:");
  try {
    trackWriter(db)({ ...recording, primary_artist: "Different Artist" });
    assert.equal(saveArtistStreams(db, observation, "2026-11-09"), 0);
    assert.equal(saveArtistStreams(db, { ...observation, asOf: "2026-10-01" }, "2026-11-09"), 0);
    assert.equal(saveArtistStreams(db, { ...observation, asOf: "2026-11-10" }, "2026-11-09"), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM stream_snapshots").get()!.n, 0);
  } finally { db.close(); }
});

test("same-title editions cannot inherit a count without the source Spotify ID", () => {
  const db = openStore(":memory:");
  try {
    const put = trackWriter(db); put(recording);
    const otherId = { ...observation, observations: [{ ...observation.observations[0], spotifyId: "3iRwigDWGH0z3R3wFmYmBW" }] };
    assert.equal(saveArtistStreams(db, otherId, "2026-11-09"), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM stream_snapshots").get()!.n, 0);
    put({ ...recording, id: "6b8Be6ljOzmkOmFslEb23P", duration_ms: 280000 });
    assert.equal(saveArtistStreams(db, otherId, "2026-11-09"), 0);
  } finally { db.close(); }
});
