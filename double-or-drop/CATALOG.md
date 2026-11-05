# Double or Drop music catalog

Double or Drop reuses the shared music library and the same live discovery provider as Encore. The current broad release contains **17,191 recordings by 4,629 artists**, with **2,016 playable artist collections** and **2,390 provider preview links**. There are 17,188 known durations, 16,295 sourced BPM measurements and 1,569 dated stream counts. Its JSON metadata is about 10.3 MB; audio and artwork bytes are not downloaded or copied.

The previous 5,000-song selection, popularity floor, alternate-version exclusion and twelve-song artist requirement have been removed. Artists need only two different recordings with a fair comparison. Logical duplicate editions cannot be paired against one another, ties are excluded at the displayed precision, and streams must share an observation date.

## Reusing the existing games

The broad release imports:

- Every English-labelled, language-reviewed recording with a valid duration in the shared maintenance database, including low-popularity songs and alternate recordings.
- Every suitable recording from all published Tempo Trap and Stream Blackjack releases. The current published pools are included completely: **835/835 Tempo tracks and 897/897 Blackjack tracks**.
- Every loaded discovery recording in Encore's unexpired or bounded stale metadata cache, including songs whose popularity is unknown.

Forty-four old Blackjack seed IDs have only undated, unsourced counts and no other known comparison measurement. Those IDs cannot become fair questions by copying their old guessed counts; measured current releases are included completely. Other language-unknown or pending-review rows in the larger maintenance database are not silently called English. Artist-specific live discovery uses the provider's owned catalog without inferring song language from nationality.

Synchronize the full shared library from the app directory with Node 24+:

```sh
npm run catalog:refresh -- --shared
```

For startup/build hooks, `--shared --optional` keeps the checked-in deployment release when the maintenance database is absent. A standalone deployment does not need the sibling database. `--encore-cache /persistent/catalog.sqlite` can point maintenance at the shared Encore cache. The `--limit` option is intentionally rejected; the importer must never publish an arbitrary popularity-limited subset.

New source data becomes available after this synchronization. Existing runs keep their pinned immutable version; refreshing metadata never changes an answer already being played.

## Live artist discovery

Encore and Double or Drop use the canonical [shared provider](../shared/music-provider/README.md). The provider searches live artist identities, checks exact artist ownership, walks returned album/EP/single releases, deduplicates recordings, and reports partial/provider-limited coverage. It keeps its existing bounded cache, timeout, request pacing and stale recovery.

- `GET /api/artists?q=Hozier` returns provider artists.
- `POST /api/artists` with `{ "artistId": "apple:...", "continue": false }` loads an artist collection.
- The response contains `catalogVersion`, `catalog`, `theme`, `artist` and `coverage`.
- If `coverage.hasMore` is true, repeat the POST with `continue: true` to check the next release batches.
- Create the run using the returned `catalogVersion` and `theme.id`.

Live collections preserve every available Encore discovery song, including unranked songs. Duration comes from that specific provider recording. Stream counts are imported only when Encore's exact ownership and unambiguous recording matching succeeded. BPM and other cross-provider facts transfer only when title/artist and recording duration agree and matching evidence has no conflicting value. Unknown measurements remain absent. A song can therefore play in duration comparisons even when it has no stream total or BPM.

Each artist selection writes a small content-addressed pack without replacing the broad collection. Provider failures preserve existing playable collections and report coverage instead of claiming the full artist discography is available. US provider availability and returned-release ceilings still apply; “all returned releases checked” is not “every recording ever made.”

Set the same absolute `MUSIC_PROVIDER_CACHE_PATH` in Encore and Double or Drop to share cache entries and provider pacing across their processes. Without it, both apps retain standalone operation with separate bounded caches.

## Facts, previews and provenance

Tempo is retained as source metadata but is no longer a playable Double or Drop metric. The current catalog has preview URLs for only 1,495 of its 16,295 BPM-tagged recordings. New games, mixed rounds, artist/genre options and direct create requests exclude tempo. Streams/runtime payloads contain no preview audio or playback links; evidence links are shown only after answering. Saved pending tempo rounds migrate without losing points or lives, while old answered results retain their original values.

- Duration and tempo in the historical broad library come from the [Spotify tracks dataset](https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset) and the existing [documented feature dataset mirror](https://github.com/cu-sanjay/MusicRecommender/blob/main/spotify_songs.csv). Tempo values are provider estimates; half/double-time interpretations can differ. Import timestamps are not measurement dates.
- English labels come from the existing maintenance catalog with its review exclusions preserved. Script and nationality are not language evidence.
- Stream observations come from [Kworb](https://kworb.net/spotify/songs.html) and its artist pages, retaining the count, evidence URL and observation date. A newer observed count is never replaced with an older snapshot during shared synchronization.
- Optional previews come only from the already matched Apple/Deezer provider URLs. HTTPS host allowlists reject lookalike hosts and credentials. Each preview keeps its recording attribution link; the application handles provider playback failures.
- Original-release-year comparisons remain unavailable unless a feed explicitly provides verified original-release evidence. An album edition or remaster date is never substituted.

The existing metadata mirror has no explicit reuse license. Review its source permissions before public redistribution. Streaming preview URLs remain subject to provider terms and availability; adding a link does not establish independent audio redistribution rights.

## Refresh observations and integrate authorized feeds

```sh
npm run catalog:refresh -- --streams
npm run catalog:refresh -- --feed https://your-provider.example/authorized-feed.json
npm run catalog:refresh -- --from-database ../music-catalog/data/music.sqlite
```

Stream maintenance validates bounded responses and changed markup before updating previously evidenced recording identities. Feed records use the [catalog types](src/lib/catalog-types.ts), require explicit `language: "en"` plus a `languageSource`, and retain HTTPS evidence per metric. Durations use seconds, tempo uses BPM, streams use positive integer counts with an ISO observation date. Year values require `quality: "verified-original-release"`. Optional popularity is a familiarity hint and never a stand-in for streams.

Feed publication validates everything before atomically updating the broad pointer. The checksum excludes publication time, so identical data reuses its version. Publication retains prior releases for saved games.

## Storage and deployment

The broad metadata corruption/resource bounds are 250,000 records and 128 MiB; these are validation limits, not selection cutoffs. An oversized import fails instead of silently dropping songs. Artist/genre indexes are cached by immutable release, and at most three parsed releases remain in process memory.

Provider metadata remains in its bounded SQLite cache. Dynamically published immutable artist packs are separate from this disposable cache. A default **256 MiB release-directory disk budget** rejects new artist packs once storage is full, while existing packs remain playable. Set `DOUBLE_DROP_CATALOG_DISK_BUDGET_BYTES` to match the deployment's volume. This publication check can have a small concurrent-worker overshoot; provision headroom and monitor the volume. It never evicts a version a saved game could still reference.

Use a persistent writable `DOUBLE_DROP_CATALOG_DIR` for runtime artist packs, seeded with the broad release and manifest. Keep the saved-game database and referenced packs together. Schedule retention against the actual production game database:

```sh
npm run catalog:refresh -- --prune --game-db /persistent/double-drop.sqlite --output /persistent/drop-catalog
```

Pruning retains every version referenced by saved games, the newest five releases, the current broad pointer and the last 35 days. Do not prune against an empty database and deploy that history over a server with active games.

## Verification

```sh
node --test tests/catalog.test.ts
```

Tests cover complete current-game inclusion, zero-popularity imports, two-song artist eligibility, duplicate-edition rejection, preview allowlists, live unranked songs, missing evidence, immutable versions, preserved broad pointers, date-compatible comparisons, feed identity and safe retention. Encore's provider, ownership, discovery, portrait and choice tests also run against the shared implementation.
