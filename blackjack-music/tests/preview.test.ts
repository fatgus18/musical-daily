import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePreview, isMatchingRecording, safePreviewUrl, type AppleSong } from "../src/lib/preview-matching";
import { NextRequest } from "next/server";
import { GET as preview } from "../src/app/api/preview/route";

const song = (trackName: string, artistName: string, extra: Partial<AppleSong> = {}): AppleSong => ({ kind: "song", trackName, artistName, previewUrl: "https://audio-ssl.itunes.apple.com/test.m4a", ...extra });

test("legitimate collaborator metadata matches across title and artist fields", () => {
  assert.ok(isMatchingRecording({ title: "All The Stars (with SZA)", artist: "Kendrick Lamar, SZA" }, song("All The Stars", "Kendrick Lamar, SZA")));
  assert.ok(isMatchingRecording({ title: "See You Again (feat. Charlie Puth)", artist: "Wiz Khalifa, Charlie Puth" }, song("See You Again (feat. Charlie Puth)", "Wiz Khalifa")));
  assert.ok(isMatchingRecording({ title: "Sunflower", artist: "Post Malone & Swae Lee" }, song("Sunflower", "Post Malone, Swae Lee")));
  assert.ok(isMatchingRecording({ title: "See You Again (feat. Kali Uchis)", artist: "Tyler, The Creator" }, song("See You Again (feat. Kali Uchis)", "Tyler, The Creator")));
  assert.ok(isMatchingRecording({ title: "Song (feat. Alice & Bob)", artist: "Singer" }, song("Song (with Bob and Alice)", "Singer")));
});

test("matching preserves recording identity, rejects covers, versions and conflicting guests", () => {
  const original = { title: "Take Me to Church", artist: "Hozier" };
  for (const candidate of [song("Take Me to Church", "Sofia Karlberg"), song("Take Me to Church (Live)", "Hozier"), song("Take Me to Church (Acoustic)", "Hozier"), song("Take Me to Church (Remix)", "Hozier"), song("Take Me to Church", "Hozier", { kind: "music-video" })]) assert.equal(isMatchingRecording(original, candidate), false);
  assert.equal(isMatchingRecording({ title: "See You Again", artist: "Tyler, The Creator" }, song("See You Again", "Tyler")), false);
  assert.equal(isMatchingRecording({ title: "Song (feat. Alice)", artist: "Singer" }, song("Song (feat. Bob)", "Singer")), false);
  assert.equal(isMatchingRecording({ ...original, durationMs: 240_000 }, song(original.title, original.artist, { trackTimeMillis: 220_000 })), false);
  assert.ok(isMatchingRecording({ title: "Dreams - 2004 Remaster", artist: "Fleetwood Mac" }, song("Dreams", "Fleetwood Mac")));
});

test("preview selection skips absent, failed and unsafe URLs instead of accepting the first search hit", () => {
  const track = { title: "Song", artist: "Artist" };
  const chosen = song("Song", "Artist", { previewUrl: "https://audio-ssl.itunes.apple.com/replacement.m4a" });
  assert.equal(choosePreview(track, [song("Song", "Cover Band"), song("Song", "Artist", { previewUrl: undefined }), song("Song", "Artist"), chosen], "https://audio-ssl.itunes.apple.com/test.m4a"), chosen);
  for (const unsafe of ["http://audio-ssl.itunes.apple.com/test.m4a", "https://itunes.apple.com.evil.test/audio", "https://localhost/private", "data:audio/mpeg;base64,AA=="]) assert.equal(safePreviewUrl(unsafe), undefined);
});

test("preview endpoint rejects tracks outside the pinned board before contacting providers", async () => {
  for (const query of ["date=2026-11-01&trackId=not-on-board", "date=2026-11-01&trackId=missing&catalogVersion=../../secret", "date=2026-11-01&trackId=missing&rulesVersion=wrong"]) {
    const response = await preview(new NextRequest(`http://localhost/api/preview?${query}`));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).previewUrl, undefined);
  }
});
