# Musical Daily music catalog

A shared, persistent music library and maintenance pipeline for independently deployed daily games. The database stores recordings and their evidence; the apps consume small, immutable releases. Adding songs does not require editing a TypeScript array or querying external APIs during gameplay.

## Run

Node 24+ is required for built-in SQLite and native TypeScript execution. No paid service or API key is needed for the included metadata imports.

```sh
npm ci
npm run import
npm run streams
npm run streams:artists -- --artists 150
npm run enrich -- --artists 120
npm run catalog -- check
npm run publish
npm run stats
npm run catalog -- search "Arctic Monkeys"
```

Or run the resumable maintenance sequence:

```sh
npm run maintain -- --artists 120
```

`--artists` is the work budget for one run, **not a catalog size limit**. Subsequent runs continue with other artists. Completed artist jobs are eligible for refresh after 30 days; `--refresh` rechecks them earlier. Failed jobs remain retryable. Metadata imports are transactional and idempotent. Apple requests are paced below approximately 20/minute, with timeouts, retries, and `Retry-After` handling. Preview availability checks run in small batches and store no audio files.

## What is stored

`streams:artists` adds deeper artist discography counts beyond the global chart. It resumes across the source's artist directory, caches each fetched page for the day, preserves the page's observation date and URL, and rejects observations older than seven days. An exact Spotify ID plus matching artist/title is required: a similar song on another edition cannot inherit its total. This command never invents counts, language labels or new song metadata. Run it before `publish` to expand Blackjack's eligible pool; it is separate from the standard maintenance command so its request budget is explicit.

The local database is [data/music.sqlite](data/music.sqlite), with WAL journaling and indexes for artist, language, and recording identity. It is ignored by Git; back it up as operational data. Generated app releases should be committed with their application source. [data/coverage.json](data/coverage.json) reports the latest publication's measured coverage.

| Table | Purpose |
| --- | --- |
| `tracks` | Spotify ID, title, artists, album, duration, release metadata, genre, BPM, language, provenance and confidence |
| `sources` | Dataset origin, declared license status, import timestamp, row count and SHA-256 digest |
| `media` | Matching provider recording, artwork, remote preview URL, last availability check and match method |
| `stream_snapshots` | Observed all-time stream totals, source and observation date; popularity scores are never substituted |
| `jobs` | Resumable enrichment checkpoints and failure details |
| `releases` | Published per-game versions and effective dates |

Spotify IDs deduplicate exact records. A separate normalized title/primary-artist key prevents album/single editions of the same song from filling the games with duplicates. Version qualifiers are retained; remix/live/acoustic recordings are excluded from automatic publication. Preview matching requires title, primary artist, and duration within 2.5 seconds. This is a conservative metadata match, not an ISRC guarantee. Reviewed BPM values take precedence over estimated values.

## Sources and coverage

- [Maharshi Pandya's Spotify Tracks Dataset](https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset): pinned 114,000-row metadata/audio-feature snapshot. Its dataset card declares BSD. Rows repeat across genres, so this is fewer than 114,000 unique recordings. The card's `en` tag describes the dataset, **not every song's vocal language**.
- [Muhammad Nakhaee's Audio Features and Lyrics of Spotify Songs](https://www.kaggle.com/datasets/imuhammad/audio-features-and-lyrics-of-spotify-songs), obtained from the [documented public mirror](https://github.com/cu-sanjay/MusicRecommender): 18,454 rows with track-level language labels and features. The listed license is unspecified. Only metadata is imported; lyric text is discarded and is never persisted in the database or cache.
- [Kworb all-time streams](https://kworb.net/spotify/songs.html): current observed totals. This page currently exposes artist/title rather than track IDs. Only exact normalized artist/title matches with compatible recording durations are admitted; the match method remains visible in the database. Observation date is the fetch date, not a claimed official Spotify reporting timestamp.
- [Apple Search API](https://performance-partners.apple.com/search-api): actual recording metadata, artwork and preview references. The `country=US` market is not treated as a language label.
- Existing manually reviewed Tempo Trap records are retained with higher-priority language/BPM evidence.

Unknown language stays unknown. Explicit language labels can transfer across matching artist/title recordings only when durations also match. Source labels and provider-estimated BPM are not equivalent to listening review of every clip. A healthy metadata record does not imply a playable preview, reliable tempo, current stream count, or rights to use the audio in a public game.

Some lyric-derived language labels describe English translations rather than the sung language. Publication conservatively excludes unreviewed records in language-specific catalog contexts (for example K-pop, J-pop and Latin genres). Other unreviewed recordings by an artist are flagged only when at least half of that artist's catalog has those contexts; a single cross-language collaboration does not disqualify their whole discography. This is a review flag, not an assertion that every song by the artist is non-English. It intentionally sacrifices some coverage. A recording-level approval with evidence takes precedence:

```sh
npm run catalog -- review-language --id SPOTIFY_ID --language en --source https://evidence.example/recording
```

This is an expandable collection, not an exhaustive index of every English song. The bulk sources are historical snapshots; refreshing them does not discover every new release. New authorized provider exports can be ingested through the adapter below. Preview availability also varies by region and can change after checking. Apple promotional-content terms do not supply a blanket license for standalone entertainment; production audio sourcing must satisfy the provider's terms separately from storing metadata.

## Add future data without changing code

Use a JSON array or JSONL file of records matching [FeedTrack](src/ingest.ts):

```sh
npm run catalog -- ingest /absolute/path/provider-export.json --source https://your-provider.example/catalog
```

Required fields: `spotifyId`, `title`, `artists` (array), `durationMs`. Optional fields: `album`, `releaseDate`, `language`, `bpm`, `bpmSource`, `popularity`, `genre`, `streams`, `streamsAsOf`, `streamsSource`.

BPM requires provenance. Stream counts require provenance and an observation date. Do not label language by guessing from artist nationality or Latin characters. The entire feed rolls back on validation failure. Missing features remain null and do not become made-up game answers. After ingestion, enrichment/check/publication reuse the same pipeline. There is no maximum song count in the schema or exporter.

## Publication and daily stability

`publish` validates **both** game pools before writing app data. Tempo requires at least 100 distinct English-labelled recordings with valid BPM, artwork and a preview checked within seven days. Blackjack requires recent, sourced stream totals and sufficient tracks in each existing stream tier. Missing requirements fail closed; existing releases remain intact.

Each app has `data/catalog-releases.json` and `data/catalog-releases/<version>.json`. Prior releases are retained. Publication starts at tomorrow in IST and selects the next unoccupied date if releases are already queued. The shared effective date must be future in both IST (Tempo) and UTC (Blackjack), so publishing after 18:30 UTC cannot change the already-active Tempo mix. `--date YYYY-MM-DD` accepts a specific unused date that passes the same boundary check. Tempo activates at midnight IST; Blackjack keeps midnight UTC. Already-published effective dates cannot be overwritten. No current daily answer changes during an import. Practice selects the newest published pool immediately.

Tempo releases include a precomputed sequence of five distinct artists per day with no recording repeated within that release's cycle. At the end of a cycle it starts again, so the game never runs out of days. Pool changes create new cycles; the no-repeat guarantee is within one release, not across every historical release. Blackjack keeps its original two/four/three stream-tier distribution and deterministic daily board generation. Both games pin answer requests to the catalog version used to create the game.

The apps remain independently deployable. They do not need SQLite, this worker, or sibling folders in production. Next.js output tracing includes the generated release files. **Rebuild/redeploy each app after publication** so its release manifest and assets ship together. Keep old versions for active sessions and daily archives.

## Operating this over time

Run one maintenance worker daily on a host with persistent storage, then commit/publish the generated app release files and redeploy. The command is suitable for cron, a CI scheduler with durable database artifacts, or a job runner. No remote scheduler or deployment credentials are configured by this repository. Do not run multiple maintenance workers against the same provider allowance simultaneously.

Keep `music.sqlite` together with the SQLite WAL when copying a live database, or back it up when the worker is stopped. The source datasets can reconstruct baseline metadata; job progress and release history should be backed up. Generated releases survive database loss and continue serving games. Do not commit raw dataset caches or secrets.

```sh
npm test
npm run typecheck
```

Tests cover deduplication, preservation of reviewed values, recording mismatch rejection, language handling, bounded rotation, changed stream-page markup, and transactional feed rollback. App tests additionally cover release selection and gameplay.
