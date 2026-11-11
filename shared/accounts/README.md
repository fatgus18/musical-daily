# Musical Daily accounts

One Google identity, one account and one stats service for the hub and all four games. The hub owns Google OAuth, sessions, result history and cross-device daily progress. Game servers use this private SDK.

## Enable Google sign-in locally

The implementation is installed, but real Google credentials are not included. Guest play remains available. There is no production test-login endpoint.

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Configure Google Auth Platform branding, audience and the OAuth consent screen. While the app is in testing, add your Google account as a test user.
2. Create an **OAuth client ID** of type **Web application**.
3. Add this exact authorized redirect URI:

   `http://localhost:3001/api/auth/google/callback`

4. Put the real credentials in the hub's ignored `musical-daily/.env.local`:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```

5. Restart the hub and game development tasks. Use **Sign in** on any page. The hub callback is the only Google redirect URI required; it hands the session back to the originating game.

Never prefix these credentials with `NEXT_PUBLIC_`, commit them or paste secrets into chat. The browser does not receive Google tokens or the service secret. Only OpenID, email and basic profile scopes are requested. See Google's [server-side OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect).

The shared local service secret and local app origins have been generated in ignored environment files for this checkout. For another checkout, generate at least32 random characters for `MUSICAL_DAILY_SERVICE_SECRET` and use the same server-only value in every app. Do not reuse a test/example secret.

## Configuration

Hub server:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MUSICAL_DAILY_SERVICE_SECRET=
MUSICAL_DAILY_AUTH_ORIGIN=http://localhost:3001
MUSICAL_DAILY_BLACKJACK_ORIGIN=http://localhost:3000
MUSICAL_DAILY_TEMPO_ORIGIN=http://localhost:3002
MUSICAL_DAILY_ENCORE_ORIGIN=http://localhost:3004
MUSICAL_DAILY_DOUBLE_DROP_ORIGIN=http://localhost:3005
ACCOUNTS_DB_PATH=data/accounts.sqlite
```

Each game server:

```dotenv
MUSICAL_DAILY_SERVICE_SECRET=
MUSICAL_DAILY_AUTH_ORIGIN=http://localhost:3001
MUSICAL_DAILY_APP_ORIGIN=http://localhost:3004
```

Use the game's own origin for the last setting: Blackjack 3000, Tempo 3002, Encore 3004, or Double or Drop 3005. Public navigation URLs should agree with these server-side origins. They are not inferred from untrusted incoming Host headers.

### Services and guest previews

In a Vercel services deployment, each game binds to the `musical-daily` service using `MUSICAL_DAILY_ACCOUNT_SERVICE_URL`. Vercel injects this variable at runtime; do not set it manually. The SDK preserves the binding's URL path when calling `api/account/service`. That URL is only used for server requests, never browser redirects. Public authentication origins remain explicitly configured HTTPS origins without a path.

`NEXT_PUBLIC_BASE_PATH` controls each game's public path prefix. The SDK prefixes OAuth return and failure paths once, including when a return path already has the game prefix. An unprefixed standalone deployment retains its existing routes. Shared service-secret authorization is still required when accounts are enabled.

For a guest-only preview, set `NEXT_PUBLIC_GUEST_ONLY=1` at build and runtime. This hides sign-in controls and disables account reads, writes, and login/callback routes, even if an old account cookie remains in the browser. No account database or service secret is required in this mode. A same-origin logout request can still clear the old game cookies. Guest gameplay storage remains each game's responsibility; disabling accounts does not make a local game database suitable for serverless hosting.

The services build wrapper defaults to guest mode and enables accounts only for the exact value `NEXT_PUBLIC_GUEST_ONLY=0`. Configure the managed accounts connection and OAuth credentials first, then rebuild all services with that value. A missing or misspelled setting remains in guest mode. The public flag is bundled at build time; editing only runtime configuration or refreshing the browser cannot enable an older deployment.

## Sessions and consistency

- Google's library verifies ID tokens. The account key is Google's immutable subject, never an email supplied by a browser.
- OAuth uses browser-bound state, PKCE and nonce.
- Vercel services use one opaque, HttpOnly `md_hub_session` cookie for the entire application. The homepage, direct game URLs and all stats pages resolve the same central identity immediately; no per-game sign-in or handoff is needed. Legacy game cookies are ignored in this deployment mode.
- Every services sign-in action returns through the hub login route. Public game origins are derived from `MUSICAL_DAILY_AUTH_ORIGIN`, so a stale standalone `MUSICAL_DAILY_APP_ORIGIN` cannot redirect players to another host.
- Separate-domain standalone deployments retain their app-bound, hashed, short-lived, single-use handoffs and distinct session audiences.
- Sign-out revokes the browser session family across all apps. Other tabs reconcile on focus and periodic refresh. A separately signed-in device retains its own session.
- An account-service outage does not silently turn a signed-in game into guest progress.

## Profile pictures

The account menu offers the ten music emojis in `ACCOUNT_AVATARS`, plus
**Default** for the original Google photo. A stable avatar ID (or `null` for
Default) is saved in `account_preferences`, separately from the Google picture,
so later Google sign-ins preserve the choice and can still refresh the photo.

Services clients send `POST /api/account/avatar` with `{ "avatar": "guitar" }`
or `{ "avatar": null }`. The authenticated session determines the account;
requests must be same-origin and may contain only a supported avatar selection.
Standalone games use their account proxy route. Session and stats responses
include the preference, and other tabs refresh after a successful save.

## Scores and guest history

The hub's **My stats** page displays four stacked cards for the current verified account. Empty accounts show empty states, never invented scores.

Blackjack and Tempo validate daily progression on the server and save progress/results atomically with revision checks. Retried requests cannot duplicate a daily result or overwrite its completed score. Tempo daily dates and streaks use IST (Asia/Kolkata) consistently across devices. Blackjack and Double or Drop use UTC for both guests and accounts, so every player gets the same daily challenge regardless of timezone.

Encore uses the central account ID in its own game database. The last answer queues a completed result in a durable outbox. Discarded or replaced mixes queue an incomplete result instead. Batches publish idempotently; network failure keeps the pending result for retry. The interface identifies pending synchronization.

Double or Drop reports `mode: "daily"` for its UTC ten-pick challenge or `mode: "practice"` for unlimited runs, `score`/`correct` as correct comparisons, `maxScore`/`rounds` as answered comparisons, and `bankedPoints` separately. Discarded runs preserve only already-banked points. A completed run counts as a win when it ends with protected points, including runs that lose their remaining lives. Accuracy is weighted across all comparisons; banked points never inflate accuracy. Result IDs are idempotent, and the hub validates integer totals and bounded banked points. The SDK app ID is `double-drop`; no extra Google OAuth client or callback is needed.

Encore and Double or Drop events use `status: "completed" | "incomplete"`; missing status remains completed for compatibility with historical results. Optional `incompleteReason` is `discarded`, `replaced`, `expired`, or `account-merge`, and is valid only for incomplete events. Incomplete events cannot win and must include their actual answer totals, including zero: Encore retains `maxScore: 10`, while Double or Drop uses `maxScore: 0` when nothing was answered. Blackjack and Tempo reject incomplete result events; a discarded Double or Drop daily attempt remains incomplete and cannot be replayed for a win.

Stats count all finalized events under `played`, with separate `completed` and `incomplete` counts. Completion score totals, averages, best scores, wins, and streaks exclude incomplete runs. Encore and Double or Drop accuracy includes every answered question across both statuses, so discarding cannot erase misses; unanswered questions never count as wrong. Protected Double or Drop banks remain in `totalBanked` and `bestBanked`. Recent results include the status, reason, and actual answer totals. Merely navigating home leaves a resumable run active and does not immediately record it as incomplete; finalizing, replacing, or expiring it records the result once.

The first verified Encore or Double or Drop game request claims server-held guest history from an existing browser cookie once, including when entering a game directly after homepage sign-in. A transactional claim ledger prevents later accounts from claiming leftovers; consumed guest cookies are rotated. Standalone login callbacks retain this behavior. Browser-only Blackjack/Tempo aggregates are not trusted or silently imported: their guest history stays local, while new signed-in games belong to the account. Logout/account switching clears the previous user's displayed data and uses separate browser-storage namespaces.

## Production

Use explicit **HTTPS** origins and register `https://YOUR_HUB/api/auth/google/callback` with Google. Production account configuration rejects HTTP origins. Configure and publish/verify Google's consent application as required for the intended audience.

The hub requires Node24+ and uses the asynchronous [shared database adapter](../database/index.mjs). Configure a dedicated Turso accounts database for production:

```dotenv
ACCOUNTS_TURSO_DATABASE_URL=libsql://YOUR-ACCOUNTS-DATABASE.turso.io
ACCOUNTS_TURSO_AUTH_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MUSICAL_DAILY_SERVICE_SECRET=
MUSICAL_DAILY_AUTH_ORIGIN=https://musical-daily.vercel.app
MUSICAL_DAILY_APP_ORIGIN=https://musical-daily.vercel.app
NEXT_PUBLIC_GUEST_ONLY=0
```

Keep the canonical `MUSICAL_DAILY_AUTH_ORIGIN` as the bare public HTTPS origin, without a game path. Vercel services derive every game's public origin from it; `MUSICAL_DAILY_APP_ORIGIN` is used only by separate-domain standalone deployments. The four game services and hub must share the same strong `MUSICAL_DAILY_SERVICE_SECRET`. Vercel supplies each game's internal hub binding separately; never set `MUSICAL_DAILY_ACCOUNT_SERVICE_URL` manually. Keep all credentials server-only and out of version control.

Production activation order:

1. Create a Google **Web application** OAuth client with the exact redirect URI `https://musical-daily.vercel.app/api/auth/google/callback` (replace the domain if using a custom domain).
2. Connect a separate Turso accounts database and set the two `ACCOUNTS_TURSO_*` variables. Keep the existing Encore and Double or Drop game databases.
3. Add the Google credentials, matching shared service secret and explicit production origins in Vercel. Leave guest mode enabled until these are ready.
4. Set `NEXT_PUBLIC_GUEST_ONLY=0` for Production and deploy the updated code so all five services rebuild with accounts enabled. Keep Preview in guest mode unless it has its own complete OAuth/database configuration.
5. Complete a real Google login from the hub and each game. Play a signed-in round and verify the same account's stats from a second device. Check logout, account switching, resumed progress and duplicate submissions before inviting more players.

Tables and indexes initialize idempotently on first use. Session creation, one-time OAuth/SSO consumption, daily score deduplication, optimistic progress updates and progress-plus-result writes are asynchronous and transactional. Bulk game results are all-or-nothing database batches. Missing managed storage on Vercel fails closed; it never creates a temporary local accounts database. Database outages return retryable failures rather than silently turning signed-in progress into guest progress.

For local development without a managed connection, `ACCOUNTS_DB_PATH` still selects a private SQLite file outside `public/`. Existing local data is not automatically uploaded to Turso. Moving an existing account database requires a deliberate database export/import; never copy browser-supplied guest scores into trusted account history. Encore and Double or Drop separately need persistent game storage. Audio-source permissions remain independent of Google authentication.

Keep service secrets private, use TLS and hosting-level rate limits, and configure database backups appropriate to the selected Turso plan. No Google Cloud project, real credentials or remote database is provisioned by the application itself.

Apps use `file:../shared/accounts`. Install/build from the workspace checkout with this package available; Next configuration traces/transpiles the workspace dependency. Shared account UI lives in [shared/account-ui](../account-ui), with checked-in app copies. Run `node scripts/sync-account-ui.mjs --check` from the workspace root to verify consistency.

## Request design and performance

In the single-domain services deployment, browsers read session and statistics directly from the hub's root `/api/account/*` endpoints. Overlapping focus/visibility refreshes share only the pending request; completed identities are not cached. Logout aborts stale reads before revoking the session, and account changes discard pending stats responses.

Blackjack and Tempo use `loadAccountProgress` to authenticate the active session and load its game progress in one indexed SQL join. A normal saved-daily read uses one game-to-hub request and one database query instead of two requests and three queries. Session expiry, audience, revocation and ownership are checked on every call; mutations still perform fresh authorization and optimistic revision checks.

The remote libSQL adapter allows independent HTTP streams instead of placing every user's request in one JavaScript queue. Local native SQLite keeps its required per-file serialization. Encore and Double or Drop lease and inspect their result outboxes in one atomic batch; after publication, acknowledgment and the final pending check are also atomic. No result is acknowledged before successful publication.

The checked-in services configuration places the hub, Blackjack and Tempo API functions in `bom1`, next to the accounts database. Encore and Double or Drop API functions remain in `iad1`, next to their existing game databases. Each function uses one region; this does not replicate or move user data. Recheck these choices if the primary database locations change. Public HTML, JavaScript and artwork continue to use Vercel's CDN. Hub responses expose an `account` duration in `Server-Timing` for diagnostics; they remain `Cache-Control: no-store`.

## Validation

Run `npm run test:accounts` in the hub for OAuth, redirects, isolation, logout, deduplication and atomic progress tests. Concurrent tests use independent local libsql connections to exercise one-time consumption, rate limits, optimistic updates and revocation; injected SQL failures verify transaction rollback. Game tests verify account-bound progression, switching and outbox retry. Browser tests use private SQLite fixtures or mocked presentation data, never an exposed login bypass. Local tests do not reproduce remote-network behavior; the production smoke check must separately verify the configured managed database.

Actual Google sign-in still requires real configured credentials and user interaction. Local test results do not claim Google's external consent flow has been completed.
