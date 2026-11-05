# Encore live catalog and retention

Encore no longer ships a bulk song/ranking export or depends on the sibling music database. Search and artist selection retrieve live provider metadata on demand. There is no fixed list of supported artists.

## Discovery and coverage

[Apple Search and Lookup](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html) supply artist identities, release metadata and preview URLs in the US storefront. Artist selection retrieves the returned album list and visits each exact-owned release, including EPs, singles, expanded editions and bonus editions. Releases are deduplicated by provider ID, never by stripping a deluxe title. Each song requires both the selected Apple artist ID and its normalized artist name, a valid provider URL and preview, and a plausible duration.

Album requests are batched to at most ten releases and an estimated 180 response records, below the 200-result lookup ceiling. At most four album batches run per application request. A persisted cursor checkpoints each successful batch; **Load more releases** resumes where the previous request stopped. Provider errors preserve completed work and leave the remainder available to retry. A 200-release response or missing release tracks is marked `provider-limited`; this public API offers no documented unlimited album pagination. “Complete” means all returned releases were visited, not every recording worldwide or every recording in another storefront.

Album/single/reissue duplicates share a stable recording key. Remaster suffixes and Part/Pt spelling are normalized conservatively. Official live-only recordings remain playable; a studio recording takes precedence when available. Karaoke, tribute recordings, remixes, demos, acoustic/choral variants and rerecordings are excluded. Neither missing previews nor guest appearances owned by a different provider artist are invented to fill a pool. Clear namesake ownership is required; partial name matching is not used.

## Popularity without a bulk local snapshot

For each requested artist, the live [Kworb artist directory](https://kworb.net/spotify/artists.html) resolves a unique exact normalized name. Its per-artist song page supplies positive stream observations, Spotify track IDs, source URL and the source's update date. **Kworb is a third-party published statistics source, not an official Spotify API.** Coverage depends on that directory and page format. A missing or ambiguous artist match falls back to an explicitly unranked Discovery mix.

Counts do not include recording duration or ISRC. Matching therefore requires exact normalized artist/title evidence and rejects conflicting count rows or conflicting preview durations. The resulting tracks carry `rankMatch: "artist-title"`; this is not a claimed ISRC verification. A ranked mix requires at least 20 distinct recordings, sufficient popularity separation and count coverage for at least 60% of the currently discovered preview collection. One artist source page and observation date are used throughout. Tier labels are relative to the available ranked pool, not worldwide familiarity.

Unknown counts are never treated as low popularity. All eligible previews remain separately available in `discoveryTracks`; when reliable ranking is unavailable, the game can offer a ten-song Discovery mix without hit/deep-cut labels. An artist with fewer than ten available previews cannot fill a complete game. Sources may omit songs or cease operating; the adapter fails into explicit unranked coverage instead of fabricating counts.

## Bounded metadata cache

The cache defaults to `data/runtime/catalog.sqlite`; set `ENCORE_CATALOG_CACHE_PATH` to a persistent writable file in production. It contains provider metadata and resumable discovery state, **not audio and not player history**.

- Apple responses and discovery state expire after six hours; artist search and stream observations expire after 24 hours.
- Previously fetched entries can recover from upstream failure for up to seven days after expiry. Such pools expose `coverage.stale`; stream ranking retains its original observation date.
- Cache payload is capped at **24 MiB**, **500 entries**, and **4 MiB per entry**. Least-recently-used entries and expired entries are removed on writes; oversize entries are not stored.
- SQLite incremental vacuum reclaims deleted pages, `max_page_count` caps the cache database at approximately **80 MiB**, and WAL autocheckpoint plus a 4 MiB journal-size target prevent a permanent append-only log. Active readers can temporarily hold WAL pages; operators should monitor disk use and avoid indefinitely open read transactions.
- The obsolete v5 metadata table is dropped and compacted automatically. It contains no game saves. The old bulk JSON exports and exporter have been removed from the application.

Provider requests have bounded queues, body limits, timeouts and single-flight deduplication. Apple calls are spaced 3.2 seconds apart and count-page calls 700 ms apart. SQLite reservations coordinate pacing between workers sharing the same cache file; separate hosts still require a shared request gateway. Short error cooldowns avoid repeatedly hitting an unavailable count source. No Spotify credentials or paid API service are provisioned by this implementation.

Player games and repeat history use the separate player-state database and keep their existing retention rules. Keep that database backed up; the metadata cache is disposable and can be rebuilt from providers. Audio is streamed directly from provider HTTPS hosts. The app's production audio-access gate and provider permission requirements remain in force; switching to live metadata does not grant additional audio rights.
