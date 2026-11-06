# Musical Daily

The home of Rhythm Lab and four music games: Blackjack Music, Tempo Trap, Encore, and Double or Drop. Rhythm Lab is a standalone creative studio at `/rhythm-lab`, with its own navigation entry and homepage feature. The responsive gallery continues to show exactly four games. Blackjack and Tempo Trap have daily challenges; Encore and Double or Drop offer unlimited play.

The compact opening puts the games immediately in view: four cards in one desktop row, compact pairs on tablets, and a 2×2 phone grid. All four game titles are visible in the first screen at the tested 320, 375 and 390 pixel phone widths, with daily/unlimited labels and short descriptions.

The home page also has its own quiet, original 124 BPM lobby groove through the [shared sound system](../shared/sound/README.md). It starts after the first genuine interaction, respects saved mute/volume, and stops immediately when launching a game or opening Rhythm Lab. Leaving for stats, hiding the tab or unmounting the home page also stops it; returning home resumes it when browser playback permission allows. The sound control remains available throughout.

## Run

Requires Node 24+ and npm. Install from the workspace checkout so the shared account package is available.

```sh
npm install
npm run dev
```

Open <http://localhost:3001>. Run the sibling games separately: Blackjack on port 3000, Tempo Trap on port 3002, Encore on port 3004, and Double or Drop on port 3005. The home screen links to those apps; it does not embed or replace them. The workspace's “Music games: start all” task starts the hub and all four games.

## Configuration and deployment

The workspace includes a [Vercel Services configuration](../vercel.json) for **one Vercel project and one domain**. Services is a Vercel Beta feature. Import the repository root (`.`), not this app's subdirectory. The hub owns `/` and `/rhythm-lab`; Blackjack uses `/blackjack`, Tempo Trap `/tempo-trap`, Encore `/encore`, and Double or Drop `/double-or-drop`. Each service builds independently with Node 24 and the checked-in wrapper. npm workspaces install the shared packages from the root lockfile. The wrapper sets the matching Next.js base path and public links at build time, so local development URLs cannot leak into this services build.

All four games declare the runtime-only `MUSICAL_DAILY_ACCOUNT_SERVICE_URL` binding to the hub, where the account API actually lives. Vercel injects this value; do not add it manually to environment variables. The shared accounts directory is a library, not another deployable service. Browser navigation uses public paths, never a bound internal URL. Service bindings do not replace application-level authorization.

This configuration is a **guest-only preview**: the wrapper sets `NEXT_PUBLIC_GUEST_ONLY=1`. Sign-in controls and account polling are disabled, and hub account routes do not initialize SQLite. Existing account cookies are ignored. Normal standalone development retains its existing account behavior.

Set a stable server-only `TEMPO_SESSION_SECRET` of at least 32 random characters in Vercel. Encore and Double or Drop use separate Turso databases through [the shared database adapter](../shared/database/index.mjs). Connect them with prefixes `ENCORE` and `DOUBLE_DROP`; the generated variables are listed in [the root environment example](../.env.example). Their schemas initialize idempotently at runtime. Both games use Encore's bounded metadata cache and provider pacing unless a dedicated music-cache connection is configured. Generated artist collections are immutable database snapshots, while bundled broad catalogs remain read-only. No game saves depend on the function filesystem. Set `ENCORE_AUDIO_ENABLED=true` to enable the existing audio game for the preview.

To exercise the real service gateway locally, run `vercel dev --local --listen 3100` from the repository root, then run `npx playwright test --config playwright.services.config.ts` from the sibling Double or Drop project. The CLI injects bindings locally. If a platform-specific CLI installation issue prevents this, the [production-app test gateway](../double-or-drop/tests/services/local-gateway.mjs) is a test-only fallback; it verifies application paths and responses, not Vercel's infrastructure. Its local databases are disposable test fixtures and must not be pointed at production credentials.

For separate standalone deployments, the existing URL configuration remains supported:

For a new checkout, start from [.env.example](.env.example); do not overwrite an existing `.env.local` containing the shared service secret. Add the two Google credentials to that existing local file. For deployment, set `NEXT_PUBLIC_BLACKJACK_URL`, `NEXT_PUBLIC_TEMPO_TRAP_URL`, `NEXT_PUBLIC_ENCORE_URL`, and `NEXT_PUBLIC_DOUBLE_DROP_URL` to the public HTTPS addresses **before building**. Each game accepts `NEXT_PUBLIC_HUB_URL` for its home link.

```sh
npm run typecheck
npm run build
npm start
```

The hub now hosts shared Google sign-in and account statistics. Follow [the account setup guide](../shared/accounts/README.md) for the exact callback URL, server-only credentials, trusted app origins and shared service secret. Sign-in remains disabled until Google credentials are supplied; guest play remains available.

Deploy on a Node 24+ host with persistent writable storage for `ACCOUNTS_DB_PATH`. An ephemeral serverless filesystem is not suitable for the SQLite account store. Replace it with a shared database adapter before using that model. Use explicit HTTPS account origins in production and include the shared account package in the build workspace.

The **My stats** tab opens `/stats`, with four stacked cards for the current account. Scores come from validated game-server results. Signing into any game uses the same account as the hub, and signed-in game links establish the corresponding game session. Double or Drop tracks total banked points, best banked run, comparison accuracy, and runs that ended with banked points.

## Structure

- [src/app/page.tsx](src/app/page.tsx): reads the game URLs.
- [src/components/home.tsx](src/components/home.tsx): game grid, navigation, help dialog, and surprise-game action.
- [src/app/globals.css](src/app/globals.css): dark visual theme, responsive layouts, and reduced-motion support.

The full browser suite in the sibling Tempo Trap project covers mobile overflow, the hub links, and both desktop and mobile screenshots. It starts both applications automatically.

## Encore

The third hub card opens Encore, an unlimited artist song-guessing game. Set `NEXT_PUBLIC_ENCORE_URL` before building the hub (local default `http://localhost:3004`). Run `npm --prefix artist-encore run dev` from the parent workspace. See [Encore setup and audio requirements](../artist-encore/README.md).

## Shared branding

The hub and all four games use one outlined SVG logo, navigation component, and responsive brand stylesheet from [the shared brand source](../shared/brand/README.md). Run `node scripts/sync-brand.mjs` from the parent workspace after editing the source; `node scripts/sync-brand.mjs --check` verifies that the deployed copies match. Each application includes its own checked-in copies, so it can deploy independently.

## Double or Drop

The fourth card opens an unlimited two-song comparison game. Set `NEXT_PUBLIC_DOUBLE_DROP_URL` before building the hub (local default `http://localhost:3005`) and `MUSICAL_DAILY_DOUBLE_DROP_ORIGIN` to the matching trusted server origin. Run `npm --prefix double-or-drop run dev` from the parent workspace. Its server uses the same shared account service and Google callback as the other games.

## Finding your next game

The gallery filters between all games, daily rituals and unlimited games. **Surprise me** opens a game picker using the current filter; it never navigates without a Play click. Consecutive settled picks differ, and reduced-motion users get the result immediately. Opening the picker keeps lobby music playing; launching its chosen game stops it. Game features include Encore's 50/50 and artist pins, Double or Drop bank goals, and Blackjack's post-game Remix Room. Rhythm Lab is a separate creative space, outside the game filters and scores.

## Rhythm Lab

Open `/rhythm-lab` from the main navigation, **Make music** near the homepage introduction, or the illustrated studio feature beneath the games. No additional server, artist API or sign-in is required. The earlier Rhythm Lab warm-up inside Tempo Trap has been removed.

Play musical notes using the on-screen piano, laptop keyboard or multitouch. Drum pads and a tempo-controlled step sequencer provide rhythm accompaniment. The studio uses the browser's Web Audio engine to synthesize its instruments; it does not record the microphone or upload performances.

**Start recording** captures the instruments and beat you play. Stop to listen back, then download the performance as a local WAV file. Each recording is limited to five minutes to bound browser memory; users can create as many recordings as they like. **New recording** discards the previous take. Leaving or refreshing the studio also discards in-memory takes, so download anything you want to keep first. Recordings are not added to account stats or retained in a server-side media library.

Desktop keyboard shortcuts are shown beside the controls. Mouse and phone touch inputs use the same instruments. High contrast and reduced motion follow the site's preferences. Audio begins after a user gesture, and homepage background music stops before studio playback.

Recording requires a current browser with AudioWorklet support, served over **HTTPS or localhost**. When testing on a phone, use an HTTPS development URL; opening the laptop's plain HTTP LAN address can play instruments but cannot record. No microphone permission is requested.

Run `npm run test:studio` for synthesis, timing, recording lifecycle and WAV encoding checks. From the sibling Double or Drop project, `npx playwright test --config playwright.studio.config.ts` verifies actual audio capture/download/playback, keyboard and multitouch input, audio interruption recovery, and the hub integration. These checks run the real browser audio engine without replacing recordings with fixtures.

## Off the record

The homepage shows a random music fact on each visit, with a discovery link and a separate **Fact check** source. **Another** draws from a shuffled rotation of 12 source-checked stories; a bounded browser history avoids repeats until the rotation finishes. **Hide** dismisses the card for the current visit, and **Show music fact** restores it. A fresh homepage visit shows a new fact again. Storage restrictions do not prevent the feature from working.

Facts and their sources live in [src/lib/music-facts.ts](src/lib/music-facts.ts), reviewed on 2026-11-04. New entries should use original, concise wording and verified historical claims with authoritative sources and real music destinations. There are no generated trivia claims or third-party API calls at page load. Run `npm run test:facts` to check the rotation and data constraints.
