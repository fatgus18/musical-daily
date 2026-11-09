# Double or Drop

A daily and unlimited music comparison game in Musical Daily. Choose between two real recordings in **20 seconds**, build a pot, and decide whether to protect it or risk doubling it. Mouse and keyboard both work. An original quiet 144 BPM backing track and action sounds make each round feel alive; everything remains playable with game sounds muted.

## The Daily Drop

Open `/?mode=daily` (or `/double-or-drop/?mode=daily` on the shared deployment) to select Daily without starting a timer. The lobby offers Daily and Unlimited independently.

- Every UTC day has **ten identical ordered pairs for everyone**, drawn from the full published collection. Banking, player history and previous answers never change this sequence.
- Three lives, 20 seconds per pick and the normal bank/risk ladder apply. Pick ten automatically banks any surviving pot. The final pair remains visible for three visible seconds before the result.
- One attempt per browser/account per UTC date. Early cashout or discard consumes the attempt too; discard is recorded as incomplete. A saved daily can resume until midnight UTC. Unfinished dailies then expire as incomplete, keeping only protected points (an already-expired pick settles first).
- Unlimited and Daily can each have one active run, so switching modes never discards the other run. Active pick clocks keep running while away.
- The first server request to start a day's challenge stores its immutable ten-pair snapshot in `daily_challenges`. Concurrent publishers use first-write-wins; new deployments/catalog releases cannot change an already published day. Future pairs and measurements are never included in public responses.
- The database enforces one attempt per player/date and one active run per player/mode. Retention keeps recent daily attempt rows even if a player completes many unlimited runs. Anonymous play relies on the browser cookie; clearing it or using another browser creates a separate guest identity.
- `GET /api/game?mode=daily` reads today's attempt and reset time. `POST /api/game` with `{ "action": "create", "mode": "daily", "requestId": "a-new-uuid" }` resumes or creates it. Client-provided dates, seeds, collections, comparison filters and catalog versions are rejected for Daily. Omitted mode keeps the existing unlimited API behavior.
- Completed daily result events use `mode: "daily"` and the challenge date; unlimited continues using `practice`. The in-game result/ticket and share text distinguish them. Account stats remain subject to the platform's sign-in availability.

`tests/daily.test.ts` covers deterministic sequences, banking-independent pairs, finite completion, timeout/expiry, hidden future answers, immutable publication races, mode coexistence, daily uniqueness after discard/retention and account claims.

## Run locally

Use **Node 24 or later**. From the workspace root:

```sh
npm --prefix double-or-drop install
npm --prefix musical-daily run dev
```

In another terminal:

```sh
npm --prefix double-or-drop run dev
```

Open **http://localhost:3005** for the game or **http://localhost:3001** for the hub. VS Code also has **Double or Drop: dev** and **Music games: start all** tasks. Existing local configuration connects this checkout to the shared account service. For a fresh checkout, copy [.env.example](.env.example) to `.env.local` and use the same server-only account service secret as the hub.

## Rules

- Each run starts with three lives and no banked points.
- Pick the song with the greater stream count or longer runtime. Mixed mode alternates the available comparisons.
- The first correct answer puts **100 points** in the pot. Each successful risk doubles it: **100 → 200 → 400 → 800 → 1,600 → 3,200**.
- **Bank & keep playing** moves the pot into protected points and starts a new ladder. **Bank & finish** saves the completed run.
- **Risk** commits to the next pair before it is revealed. You cannot inspect that pair and then cash out the previous pot.
- Each pick has a server-enforced **20-second deadline**. Reloads, help, and returning home do not pause or reset it. Banking decisions have no timer.
- A wrong pick or timeout loses the pot and one life. Banked points stay. Three misses finish the run.
- The third miss remains on the pair screen for at least **three visible seconds**, showing the wrong selection and correct values before results. Hidden/home time does not consume this display interval; reloading resumes it. The saved result remains final and is never counted twice.
- At 3,200 you must bank before continuing. Unlimited has no quota or normal round limit; Daily has ten picks and one attempt. Defensive storage limits finish a single extreme unlimited run at one million comparisons or one billion banked points; a new unlimited run remains available.
- Press **1 / 2** to pick, **B** to bank, or **R** to risk. Instructions suppress game shortcuts while open. Reduced-motion preferences disable animations.

The game logo and **Game home** return to the game lobby while preserving the active run. From there, resume or discard the saved run and choose a fresh setup. Discarding records an **incomplete run**, keeps protected banked points, and forfeits any unbanked pot. It does not automatically start another clock; the next run begins only when you press play. Returning home or closing the tab alone does not mark a run incomplete. An active clock keeps running; expired picks settle once when the browser reconnects. Guest persistence requires the anonymous HttpOnly cookie. Signed-in runs belong to the shared Musical Daily account. Legacy untimed runs receive one persisted fresh 20-second deadline on first access.

## Music and fairness

The November 9, 2026 broad library contains **17,672 recording records by 4,631 artists**, including every recording in the newest Tempo and Blackjack releases and available Encore cache data. It has **2,012 playable artist collections**, **3,198 sourced stream counts** and **4,972 preview references**. Artist collections need two distinct comparable recordings, with no popularity floor. The shared-library synchronization runs before development/build when maintenance sources are present, or manually with `npm run catalog:refresh -- --shared`. Add a named provider collection using `--artist "Hozier"`; repeated `--artist` options and `--continue` support more discoveries without editing arrays.

Search also reaches the same live provider as Encore. Choosing a provider artist loads an immutable collection from its available releases. **Load more releases** continues partial discographies. Only known measurements are used: an unranked song can play in runtime mode without invented BPM or stream counts. Set the same `MUSIC_PROVIDER_CACHE_PATH` in Encore and this app to reuse cached discoveries and request pacing. Provider/region availability remains a limit; this does not claim every recording ever released.

Early comparisons favor familiar recordings and clearer differences. Higher risk levels narrow the relative gap. Bounded recent history follows the player across runs; small collections can eventually repeat. Missing values, duplicate recordings, visible ties, and differently dated stream snapshots cannot form a comparison. Each reveal includes evidence links and observation dates when available. Release-year comparisons are withheld until original release dates are evidenced, rather than using reissue dates.

Read [CATALOG.md](CATALOG.md) for provenance, limitations, English-language filtering, provider-feed format, and safe release retention. Tempo values are historical estimates and can have half/double-time interpretations. Counts are dated observations, not live Spotify API counters. Some existing metadata mirrors have unspecified reuse permissions; review those sources or supply cleared feeds before public redistribution.

Refresh verified stream counts:

```sh
npm run catalog:refresh -- --streams
```

Expand with an authorized metadata feed:

```sh
npm run catalog:refresh -- --feed https://your-provider.example/authorized-feed.json
```

Catalog publication is validated and atomic. A run pins its immutable catalog version, so refreshing numbers never changes its answers. Existing collections do not depend on provider uptime; new live artist discovery requires the provider. Runtime does not require the sibling bulk maintenance database. Bounded caches and release retention control storage growth.

## Sound and comparison policy

The [shared sound system](../shared/sound/README.md) supplies click/selection sounds on the hub and all four games. Double or Drop adds distinct correct-answer, life-loss, timeout, risk and coin-bank tones. Background music uses an original synthesized 144 BPM arrangement, quiet by default at 16% music volume. No sampled songs or audio downloads are used for these effects.

Sound starts only after user interaction. The sound control mutes music/effects together, with separate volume sliders for effects and backing music. Preferences persist and are shared across apps on the same hostname. Background music stops on game home, completion, hidden tabs and song preview playback. Preview controls remain independent of the game-effects mute.

Tempo comparisons have been removed from Double or Drop: only 1,495 of the 16,295 BPM-tagged recordings had preview URLs, so the whole category could not provide the required listening experience. The metadata stays available for history and shared-source reuse. Tempo Trap is unaffected.

New streams/runtime rounds have no song preview controls, preview URLs or playback links in their game payload. Evidence links appear only after an answer is revealed. Historical, already-answered tempo pairs can retain their preview controls, with full-song links exposed only after the answer. Pending saved tempo questions migrate to supported comparisons before their old deadline can cost a life; points/history are retained and the replacement gets a fresh 20-second window.

## Accounts and stats

The app ID is `double-drop`. It uses the [shared Google account service](../shared/accounts/README.md), the common header/logo, and the common account controls. No separate Google OAuth client is required. This game’s `/stats` page displays its own card and recent results; the hub’s `/stats` page retains all four game cards using the same shared design. Guest pages show an honest sign-in empty state.

Verified sign-in claims this browser's server-held guest runs. If the account already has an active run, that run is retained and the guest run is recorded as incomplete. Only already-banked guest points are preserved; an outstanding guest pot is never automatically banked. Account switching never reuses another account's run.

Completed runs with at least one answer publish a server-calculated event. Discarded runs publish an incomplete event even if no pick was made; no fictitious pick or zero-accuracy comparison is added. Banked points are tracked separately from correct/attempted comparisons. Incomplete runs do not count as wins or completed runs. Their banked points remain protected, while completed-run score and accuracy aggregates stay separate. Finishing before making any picks also records an incomplete run. A normal cashout after answering, losing the final life, or reaching a defensive run limit remains a completed run.

An idempotent outbox retries account-service failures without double counting; the UI identifies pending synchronization. Discard uses the saved run ID and revision, so a repeated or stale request cannot discard a different fresh run. The server settles any elapsed pick first: if that was the third timeout, the run remains completed rather than being relabeled incomplete. Guest discards are claimed on verified sign-in and published once. Historical events without an explicit status retain their existing completed classification.

## Production deployment

Build from this workspace with [shared/accounts](../shared/accounts) present:

```sh
npm ci
npm run build
npm run start
```

Set explicit HTTPS `MUSICAL_DAILY_APP_ORIGIN`, `MUSICAL_DAILY_AUTH_ORIGIN`, `NEXT_PUBLIC_HUB_URL`, and the matching hub `MUSICAL_DAILY_DOUBLE_DROP_ORIGIN` / `NEXT_PUBLIC_DOUBLE_DROP_URL`. Public navigation settings are applied at build time. Use the same private `MUSICAL_DAILY_SERVICE_SECRET` across the hub and game servers. Google credentials and consent configuration belong in the hub; no credentials or deployment are provisioned by this app.

The server requires Node 24+ and uses **managed libSQL/Turso storage on Vercel**. Set server-only `DOUBLE_DROP_TURSO_DATABASE_URL` and `DOUBLE_DROP_TURSO_AUTH_TOKEN` to a dedicated Double or Drop database. Encore uses different game-table structures and must have a separate database. Tables initialize automatically. All function instances share transactions, request limits, guest runs, personal records and the result outbox. Vercel refuses to start this storage layer without its managed connection; it never silently saves a run to temporary disk.

The broad catalog stays in the read-only deployment bundle. Live artist collections are hash-validated immutable snapshots in the managed database, so a run can resume after a cold start or redeployment. New-run pinning and cleanup are coordinated transactionally. Each artist snapshot is limited to 8 MiB; the total default metadata budget is 256 MiB, configurable with `DOUBLE_DROP_CATALOG_STORAGE_BUDGET_BYTES`. This is a resource bound, not a popularity or song-count filter. Existing pinned collections remain available if the budget is reached. The live provider cache uses `MUSIC_CACHE_TURSO_DATABASE_URL` / `MUSIC_CACHE_TURSO_AUTH_TOKEN`, or shares Encore's database through its `ENCORE_TURSO_DATABASE_URL` / `ENCORE_TURSO_AUTH_TOKEN` configuration.

For local development, `DOUBLE_DROP_DB_PATH` still selects a SQLite file, defaulting to `data/double-drop.sqlite`. Set it to a private persistent path outside `public/` on a traditional host. Runtime artist snapshots use that same database; the bundled catalog directory no longer needs to be writable for artist search.

`GET /api/health` reports 200 only when storage and the current catalog are readable. It exposes no account/session data. Responses containing game state are private and uncached. Write routes validate origin, JSON shape and bounded body size. Server-side identity, transactional revision checks and idempotent request IDs protect scoring; the browser never receives the current comparison values before answering. Apply hosting-level abuse controls in addition to the per-player rate limits.

Retention runs at most daily during normal traffic, or explicitly with:

```sh
npm run storage:prune
```

This uses the deployment's managed database configuration, or `DOUBLE_DROP_DB_PATH` locally. Runs inactive for 30 days expire as incomplete without banking outstanding risk, unless settling their elapsed pick naturally finishes the run first. Abandonment work is bounded to ten short transactions per pass; the command continues until those batches are drained. Terminal game history retains at most 50 runs per player for 90 days; pending account results are preserved until synchronized. Unreferenced runtime artist snapshots are eligible for cleanup after 35 unused days. Every version still referenced by a saved run is retained. Bundled release pruning remains a separate maintenance operation described in [CATALOG.md](CATALOG.md). Monitor unsynchronized results and health failures operationally.

## Verification

```sh
npm test
npm run typecheck
npm run test:e2e
npm run build
```

Unit tests cover scoring, risk commitment, score limits, catalog fairness, large tied pools, repeat avoidance, immutable snapshots, transactions, isolation, guest claims, idempotent result publishing, retry leases and retention. Browser tests exercise real catalog rounds, keyboard choices, bank/risk/lives, reload and home navigation, six-step ladders, responsive layouts, reduced motion, lost responses, origin checks and cross-browser ownership.

The browser tests use isolated guest cookies against localhost ports 3005 and 3001; they do not require Google credentials. Live Google consent/redirect testing and remote deployment checks still need the real deployment configuration.
## Make each run your own

Choose an optional **500, 1,000, or 3,200-point bank goal** in the lobby, or keep Free play selected. The goal counts protected banked points only; an at-risk pot never fills the meter. Reaching a goal does not end or change a run. Goal progress stays with the server-saved run, including after refresh and discarding. Correct streaks at 3, 6, 10, 15, and 20 picks receive a short celebration, as does banking a goal or exceeding the saved best. Celebrations are triggered by live state changes and do not replay on reload.

**Personal best** is the largest protected bank from a finalized saved run, including banked points from an incomplete run. It is stored server-side in `personal_records`, persists after detailed run history is pruned, and merges by maximum when a verified Google sign-in claims this browser’s guest history. Existing retained runs and account outbox results seed the record when this feature is first installed; older already-deleted history cannot be reconstructed. A run snapshots the best at its start so the benchmark does not move mid-run. Guests retain their record with their browser identity; signing in carries it to their account. No client-submitted personal-best value is trusted.

