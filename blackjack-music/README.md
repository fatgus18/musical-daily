# Stream Blackjack

A Musical Daily push-your-luck game. Everyone gets the same dated 3x3 track board and target. Track stream counts are returned only after a track is selected; the full answer and optimal hand are revealed after standing or busting. Unlimited Free Play deals fresh boards.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Song pools come from dated releases of the shared music catalog. The historical 105-track illustrative pool is retained only to preserve puzzles from before the expanded catalog activates.

Set `NEXT_PUBLIC_HUB_URL` to the public Musical Daily homepage when deploying (defaults to http://localhost:3001). Both the header and footer link directly back to the hub. The game uses its own Musical Daily branding, with violet and coral accents.

## Rules

- Pick tracks to add their stream totals while staying at or below the daily target.
- The first over-cap pick is burned, consumes the bust shield, and does not change the safe total.
- A later over-cap pick ends the hand as a bust. Standing locks the current total.
- The answer screen reveals every count and the best 3-to-5 track hand.
- Ranks: Blackjack at 98%+, Gold Record at 90%+, Charting at 75%+, and Soundcheck below 75%.
- **Every new daily and Free Play board has a 3–5-track hand that totals exactly 100% of the cap.** At 98%, you can stand for Blackjack or keep playing for a perfect hand. Reaching exactly 100% automatically locks it in. The exact numerical cap appears beneath the abbreviated meter; revealed counts have exact values in their tooltip and accessible label.
- Guest streaks and completed results remain in browser storage. Signed-in daily hands and statistics sync with the Musical Daily account.

## Exact-target guarantee and saved games

The `v3-exact` generator enumerates all 336 three-, four- and five-track subsets of the nine-song board. It chooses the cap from their **actual sums**, preferring caps with multiple Blackjack hands and at least eight Gold Record hands. It never rounds or fabricates the underlying stream counts. The two-heavyweight/four-mid-tier/three-finesse distribution always supplies a valid in-range candidate: the four mid-tier songs total between 3.4B and 7.2B. Generation fails closed if a malformed catalog breaks those assumptions or the independently computed optimum does not equal the cap.

Old saved daily games use `v2` with their original board, cap and 98% auto-lock behavior. New saves pin both `catalogVersion` and `rulesVersion`; all reveal/finish requests carry them. A legacy saved game without these fields is explicitly restored with `v2`. This preserves played results instead of changing the target midway through a hand. The exact-cap promise applies to newly dealt `v3-exact` games, including Free Play immediately.

The API rejects unknown board versions, malformed dates, duplicate/foreign track IDs and malformed hands. Network failures show a retry message, completed requests are guarded against duplicate clicks, and a failed finish preserves the hand for another lock-in attempt. Signed-in picks and shield use are server-owned; finishing recomputes the rank from that saved hand. This remains a casual game, without a competitive leaderboard.

## Musical Daily accounts

The shared [account service](../shared/accounts/) connects Google sign-in to the hub's account database. The same Google identity has one account across all games, including when arriving directly at this game. Set `MUSICAL_DAILY_AUTH_ORIGIN` to the hub, `MUSICAL_DAILY_APP_ORIGIN` to this game's origin, and `MUSICAL_DAILY_SERVICE_SECRET` to the same server-only secret configured on the hub. Google credentials belong on the hub. Register `http://localhost:3001/api/auth/google/callback` as the local Google authorized redirect URI; production uses the exact same path on the public HTTPS hub origin. Game callbacks are internal handoffs, not Google redirect URIs. See the hub [README](../musical-daily/README.md) for setup. Keep the sibling shared package available during dependency installation and deployment.

Account daily progress uses a UTC date so devices in different time zones share the same daily board. Guest saves retain their original local-date behavior. Server compare-and-swap revisions prevent two devices from overwriting one another; a conflict asks the player to reload the saved hand. Completion and its score are written in one database transaction. Retrying a lost response returns the first completed daily result and never counts another game. Account statistics use cap closeness from 0 to 100, with busts scoring zero; wins advance the daily streak. Free Play remains outside daily statistics.

Browser save keys are separated by account, and identity changes stop playback and reload that identity's state. Guest browser aggregates are not imported or silently claimed on sign-in, because their old client-only scores cannot be verified. Account-service outages preserve the saved hand and offer a retry rather than downgrading an account game to guest mode.

## Audio previews

Every card has a preview control, including tracks whose published metadata does not yet contain a preview URL. Missing previews are looked up when requested, so a board does not wait for nine external music searches before it can be played. A successful lookup also supplies missing cover artwork. Playback stops after 30 seconds; short/broken audio files trigger a repair lookup, and unavailable previews or provider outages show a retry message instead of silently failing. Switching tracks, starting a new board or leaving the page stops the previous audio. Some browsers require another tap after a network lookup before they permit playback.

The server checks the track against the exact pinned board before looking up media. Apple Search candidates must match the recording title and credited artists, allowing equivalent `feat.`, `with`, comma and ampersand formatting. Live, acoustic, remix and rerecorded versions are kept distinct; covers and unrelated first search results are rejected. Known durations must agree within five seconds. Only HTTPS preview URLs from known audio providers are accepted. US and GB storefronts are checked; a matching preview is not guaranteed for every recording or territory. Stream counts and the exactly reachable cap never change because a preview is missing.

Preview metadata is cached in ignored [data/runtime](data/runtime) storage, bounded to 500 entries. Positive results expire after 24 hours, confirmed misses after six hours and temporary failures after one minute. Repeated requests share pending lookups; provider searches are paced to one every 3.2 seconds per process with a bounded queue. Persistent cache failure falls back to bounded memory. Production deployments with multiple replicas should use a shared cache/request budget. Audio is streamed directly from its provider, never downloaded or rehosted by this app. Existing provider-use permissions and terms still apply.

## Refresh track data

### Album artwork

Every recording in the current 897-song production pool and historical releases has cover metadata in [data/artwork.json](data/artwork.json), independently of its preview availability. This metadata overlay preserves every catalog version, song ID, stream count and saved daily answer. Spotify's original `i.scdn.co` and current `image-cdn-*.spotifycdn.com` hosts are supported. Missing covers resolve by the exact Spotify track ID, with an identity-checked Apple recording fallback. Successful lookups persist in a bounded runtime cache; temporary misses retry after a minute. A failed image can request a board-validated alternate CDN URL or matching artwork without replacing its song.

After publishing a new track catalog, run `npm run refresh:artwork` before building. The command checks every historical/current published recording, writes the metadata overlay, and exits unsuccessfully if any remain missing. Four entries retained only in the old illustrative 105-track pool have an [audited artwork mapping](data/legacy-artwork.json): the Karan Aujla tracks omitted co-artist credits and Hozier's canonical album track omitted its `(Live)` suffix. Exact Apple track, artist and album IDs, source links and review reasons are retained. These exceptions are limited to those historical IDs/title/artist/year combinations and never relax preview matching or change saved answers. Only image URLs and source metadata are stored; images remain on their provider's CDN. Provider/CDN outages can still temporarily prevent a browser from loading an image, so coverage is not a guarantee of perpetual external availability.

Install dependencies in the sibling [music-catalog](../music-catalog/README.md) project, then run:

```bash
npm run import:tracks
```

This delegates to the shared resumable maintenance pipeline: bulk metadata, source language labels, current Kworb stream observations, preview enrichment, validation and future-dated publication. No Spotify API credentials are required for the included sources. Stream values are observations with provenance, not illustrative estimates or popularity scores.

The game reads [data/catalog-releases.json](data/catalog-releases.json) and immutable files in [data/catalog-releases](data/catalog-releases). Daily dates select their effective release; practice uses the newest release immediately. Reveal/finish requests carry the board's catalog version, so subsequent publication cannot change an active hand's values. Rebuild/redeploy after publication; generated files are included by Next.js output tracing. Each release must satisfy the existing two-heavyweight/four-mid-tier/three-finesse distribution. Missing metadata fails publication instead of silently substituting fabricated counts.

## Checks

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

The tests independently enumerate possible hands across 1,461 dates for **every** published catalog plus 100 practice seeds per catalog; they verify exact sums, deterministic boards, original stream values, legacy restoration, and API input validation. This supplements the constructive guarantee in the generator.

## The Remix Room

After finishing a hand, open **The remix room** to combine the nine revealed tracks without altering the saved result. It shows exact stream totals, over-cap feedback, a best-hand reveal and a nudge toward the best combination requiring the fewest changes. It also supports historical boards whose best hand falls below the target. This component uses only the completed response's `allStreams` and never submits a score or reveals counts during live play.
