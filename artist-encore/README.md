# Encore

An unlimited artist song-recognition game for Musical Daily. Play solo with ten-second clips, or invite friends to a shared Encore room with fifteen-second clips and early guessing.

## Run

Node24+ and npm are required.

```sh
npm ci
npm run dev
```

Open <http://localhost:3004>. The hub defaults to <http://localhost:3001>. The workspace's **Music games: start all** task starts the hub and four games.

## Encore Rooms

Open `/rooms` in the standalone app or `/encore/rooms` on Musical Daily. A host
chooses an artist and shares a six-character code or invite link. Rooms hold 2–8 players, including the host.
Guests can play with a nickname; signed-in users bring their selected music avatar.

- Ten songs are selected from the existing live artist catalog. Ranked mixes use
  six hits, three favorites and one deep cut; discovery mixes work when reliable
  popularity coverage is unavailable. Rematches prioritize less-used recordings.
- Players enable sound and ready up. The current preview buffers before the
  shared countdown. Tap **Guess now** to stop listening early and see
  four choices. Each player gets fifteen seconds to answer, within a shared
  thirty-second round. There is one answer and no replay after opening choices.
- Every correct answer earns 1,000 points. Equal scores use the total server-timed
  duration of correct answers, including listening, rounded down to tenths of a
  second. Wrong guesses cannot improve this tiebreaker. Exact ties share a rank.
- Correctness is revealed together after all answers or the deadline. A five-second
  reveal leads to the next song. Failed loading can be retried by the host or
  voided for everyone; a loading timeout never counts as a wrong answer.
- Reconnecting with the same browser cookie retains membership and timing.
  New players join only in the lobby. Offline players stop blocking preparation
  after 45 seconds; the host role can pass to someone present. Explicitly leaving
  forfeits winning, while temporary disconnects retain earned scores.
- Room leaderboards are separate from solo Encore account statistics. Rooms
  expire after two hours without player activity; finished results expire after
  24 hours. Bounded cleanup runs as new rooms are created.

The existing Encore database stores the additive `encore_rooms` table. No new
database service or credentials are required. Clients fetch short authenticated
snapshots; a normal poll uses one read, with transactions only for player actions
and clock transitions. Timers and answer acceptance belong to the server, not the
browser. The room cookie is opaque and HttpOnly; room responses omit email,
account identifiers, future tracks and unrevealed answers.

The audio route authorizes the member, match, round and retry version before and
after fetching an allowlisted provider preview. It removes descriptive MP3/MP4
tags, limits downloads to 3 MB and retains only a bounded two-minute warm cache.
This is a casual friend-room game, not an anti-cheating system against external
song recognition or modified clients.

From this app's directory, unit tests run with `npm test` and room browser tests
with `npx playwright test --config playwright.rooms.config.ts`. Start the disposable
HTTPS services fixture from the workspace root first, using
`ACCOUNTS_TEST_FIXTURE=1 node double-or-drop/tests/services/local-gateway.mjs`
(PowerShell: `$env:ACCOUNTS_TEST_FIXTURE='1'` before the Node command). The fixture
uses built production apps. Its database seeding and clock controls are test-only
and are never application endpoints.

## Live catalog and modes

Encore now discovers artists and releases through Apple's public Search/Lookup APIs. It no longer depends on a bundled ranking export, an artist allowlist or the sibling catalog database. It visits returned albums, singles, EPs and bonus editions, deduplicates recordings and requires exact provider artist ownership. Artist-specific stream observations are fetched on demand from Kworb.

- **Ranked:** six hits, three fan favorites, one deep cut. Requires20 ranked recordings, distinct measurements and broad count coverage. Missing counts never become niche songs.
- **Discovery:** ten songs from the available catalog, without popularity labels. Requires ten distinct previews. This mode is offered explicitly when counts are limited and remains available through **Explore this artist's catalog** for ranked artists too.
- **Load more releases** advances a saved discography cursor. Coverage shows preview counts, evidence counts, missing results and remaining releases.
- New mixes prioritize least-used recordings, then those heard longest ago. No mix repeats a recording; small pools necessarily repeat between mixes.

The public Apple album lookup has a200-result ceiling and no supported pagination cursor. Encore checks all returned releases and discloses saturation, unavailable tracks and work-budget limits. It does not claim every song worldwide. An authorized paginated provider is needed for very large discographies beyond that ceiling.

Kworb is a separate source, not an official Spotify API. Spotify's public API does not provide universal stream totals. No measurements are invented when counts are unavailable. See [catalog provenance and operations](data/README.md) for matching rules and limits.

## Gameplay and recovery

The player streams ten seconds starting seven seconds into the provider preview. The provider chooses its location within the full recording. When the clip ends, a server-owned 15-second guessing window starts. Choose one of four song titles before it expires; an unsubmitted answer times out for zero. Replays consume the same remaining time. A submitted answer is final. Each round offers four distinct songs by the selected artist; click or keyboard-select one to lock it in. Each correct title counts once, for a score out of ten.

Only the current clip is sent before listening. Four choices appear when the guessing timer begins; the correct title and album artwork are revealed after answering. Saved games use an anonymous HTTP-only cookie. Reload resumes the round without resetting its deadline; hiding or leaving the page cancels playback. Click the Encore title anytime to return to its artist-selection screen. The home view survives reload, the mix remains saved, and an active guessing timer continues; resuming reconciles with the server first. Failed clips can be retried or replaced without score penalties. Replacement retries are idempotent and ranked replacements retain the original catalog cohort.

Every mix includes one **50/50 lifeline**. Use it while guessing to remove exactly two wrong choices; the correct answer and one randomly selected wrong answer remain. The existing 15-second deadline keeps running. Every correct answer still earns its usual point, including assisted rounds, which are marked in the reveal, results and share text. Use is stored on the server and survives reloads, duplicate requests, another tab and later clip replacements. Stale requests cannot submit a removed option. An expired round cannot spend the lifeline.

**Your front row** holds up to eight pinned artists for quick replay. Stars beside search results, catalog offers and the current artist pin or unpin an artist. This list is saved on this browser, independently of account sign-in; it is not account-synced. Only validated provider IDs and display names are stored, never track lists or playback URLs. Selecting a pin uses the same server-validated artist/catalog flow as search and builds a fresh mix. If browser storage is unavailable, pins remain temporary in the current tab and the shelf explains this. Filling all eight places never silently evicts an artist.

The last five guessing seconds use a high-contrast outline, glow and gentle shake, with one screen-reader warning. Reduced-motion preferences retain the static highlight without animation. Older saved untimed guessing rounds receive one 15-second deadline on their first server reconciliation; existing scored results stay unchanged.

The home screen offers **Discard saved mix** alongside resume. Returning home alone preserves progress. Discarding, replacing with a successfully created new mix, or expiring an unfinished mix records one **incomplete** result with its actual answered-song count and correct answers. Failed catalog lookups leave the existing mix intact. Ten answered songs always count as completed, even before the last reveal is dismissed. Finished or discarded mixes cannot be resumed by stale requests; retries cannot duplicate their stats.

Duplicate album/single/remaster editions share recording identities. Studio recordings take precedence over live duplicates; official live-only originals remain eligible. Ambiguous recording/count matches stay outside ranked play. Matching is conservative artist/title evidence, not an ISRC guarantee.

Artist portraits come from matching Apple Music artist profiles, with a source link. Album covers are used only for song reveals. Missing or failed profile images use a neutral placeholder.

## Google account and shared stats

Sign in through the header to use the same account as Musical Daily and the other games. See [Google setup and deployment](../shared/accounts/README.md). The same verified account restores Encore progress across browsers. Signing out stops audio and clears the previous account's displayed game.

On verified login, this browser's server-held guest games and repeat history are claimed once. Completed mixes are queued in a durable outbox and synchronized to the hub without duplicates. A failed stats request leaves the game result saved locally on the server and offers retry; synchronization is skipped during active listening/guessing to avoid using answer time.

Incomplete mixes use the same durable outbox. The shared hub and Encore stats page separate them from completed mixes; unanswered songs do not become wrong guesses in accuracy. When login finds an active account mix and an active guest mix, the account mix stays resumable and the guest mix is recorded as incomplete. Finalized guest events remain claimable for 180 days, including events whose detailed game record has expired.

## Bounded storage

API access still needs caching for speed, provider allowances and temporary outages. Audio is never persisted; room previews use the temporary authenticated proxy described above.

- Apple metadata expires after six hours; count observations after24 hours. Visits do not extend the original fetch time.
- Disclosed stale recovery is bounded to seven days.
- Provider cache has byte, entry and physical-size safeguards, plus SQLite reclamation. Oversized collections report incomplete coverage rather than silently looping.
- Provider pacing is coordinated across processes sharing the same cache on one host. Multiple hosts need a shared limiter.
- Cleanup runs at most daily. Completed/discarded game details expire90 days after finishing; unfinished games30 days after creation. At most50 recent games remain per browser identity. Unfinished records are finalized into the result outbox before retention removes their details. Unsynchronized account results are retained until delivery; finalized guest events expire after180 days.
- Repeat history expires after180 days and is capped at5,000 recordings per identity. Request-limit records expire after seven days.

```sh
npm run storage:prune
# Reclaim unused game-database pages during a maintenance window:
npm run storage:prune -- --vacuum
```

SQLite reuses deleted pages. Explicit vacuum reclaims disk space and can block writers. Cache maintenance also checkpoints its WAL and reclaims unused pages. Storage follows active use rather than a growing bundled music export.

## Deployment

Deploy on a Node24+ host with persistent writable storage:

- `NEXT_PUBLIC_HUB_URL`: public hub URL before building.
- `ENCORE_DB_PATH`: persistent game database path.
- `ENCORE_CATALOG_CACHE_PATH`: persistent provider-cache path.
- `ENCORE_AUDIO_ENABLED`: explicit production audio activation after suitable access is obtained.

Production audio is disabled by default. Apple's [promotional-content terms](https://performance-partners.apple.com/search-api) do not grant a standalone entertainment-game license. A configuration switch is not a license; obtain appropriate permission or use a licensed audio source before public launch.

Set `NEXT_PUBLIC_ENCORE_URL` on the hub. Encore deploys independently without a sibling database or bulk export.

```sh
npm run build
npm start
```

An ephemeral serverless filesystem will not preserve SQLite state. Use persistent storage or a shared database adapter for multiple hosts. Back up state consistently with its WAL and apply infrastructure rate limits. This casual game does not claim account-based competitive anti-cheating: media URLs are visible to a determined browser user.

The canonical logo is synchronized from [shared branding](../shared/brand/README.md), with copies inside each app for independent deployment.

## Validation

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Tests cover ownership, release traversal, EPs/bonus editions, deduplication, unknown counts, explicit discovery,6/3/1 selection, repetition, persistence, replacements, freshness and retention. Browser tests cover real audio, Hozier coverage, discovery confirmation, mobile layout and navigation. Live checks need provider access. Windows uses installed Chrome; other systems require Playwright Chromium.
