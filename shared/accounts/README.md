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

## Sessions and consistency

- Google's library verifies ID tokens. The account key is Google's immutable subject, never an email supplied by a browser.
- OAuth uses browser-bound state, PKCE and nonce. Game handoffs are app-bound, hashed, short-lived and single-use.
- Opaque HttpOnly cookies have distinct app audiences. Separate domains work without parent-domain cookies or cross-origin browser API writes.
- Signing in through a game signs into the hub too. Links from a signed-in hub automatically establish the game session. Another game's direct URL may need one Sign in click; an existing hub session avoids another Google prompt.
- Sign-out revokes the browser session family across all apps. Other tabs reconcile on focus and periodic refresh. A separately signed-in device retains its own session.
- An account-service outage does not silently turn a signed-in game into guest progress.

## Scores and guest history

The hub's **My stats** page displays four stacked cards for the current verified account. Empty accounts show empty states, never invented scores.

Blackjack and Tempo validate daily progression on the server and save progress/results atomically with revision checks. Retried requests cannot duplicate a daily result or overwrite its completed score. Account daily dates use UTC consistently across devices; guest Blackjack retains local dates.

Encore uses the central account ID in its own game database. The last answer queues a completed result in a durable outbox. Discarded or replaced mixes queue an incomplete result instead. Batches publish idempotently; network failure keeps the pending result for retry. The interface identifies pending synchronization.

Double or Drop reports `mode: "daily"` for its UTC ten-pick challenge or `mode: "practice"` for unlimited runs, `score`/`correct` as correct comparisons, `maxScore`/`rounds` as answered comparisons, and `bankedPoints` separately. Discarded runs preserve only already-banked points. A completed run counts as a win when it ends with protected points, including runs that lose their remaining lives. Accuracy is weighted across all comparisons; banked points never inflate accuracy. Result IDs are idempotent, and the hub validates integer totals and bounded banked points. The SDK app ID is `double-drop`; no extra Google OAuth client or callback is needed.

Encore and Double or Drop events use `status: "completed" | "incomplete"`; missing status remains completed for compatibility with historical results. Optional `incompleteReason` is `discarded`, `replaced`, `expired`, or `account-merge`, and is valid only for incomplete events. Incomplete events cannot win and must include their actual answer totals, including zero: Encore retains `maxScore: 10`, while Double or Drop uses `maxScore: 0` when nothing was answered. Daily games reject incomplete result events.

Stats count all finalized events under `played`, with separate `completed` and `incomplete` counts. Completion score totals, averages, best scores, wins, and streaks exclude incomplete runs. Encore and Double or Drop accuracy includes every answered question across both statuses, so discarding cannot erase misses; unanswered questions never count as wrong. Protected Double or Drop banks remain in `totalBanked` and `bestBanked`. Recent results include the status, reason, and actual answer totals. Merely navigating home leaves a resumable run active and does not immediately record it as incomplete; finalizing, replacing, or expiring it records the result once.

Verified Encore login claims server-held games and repeat history from that browser's anonymous cookie once. Browser-only Blackjack/Tempo aggregates are not trusted or silently imported: their guest history stays local, while new signed-in games belong to the account. Logout/account switching clears the previous user's displayed data and uses separate browser-storage namespaces.

## Production

Use explicit **HTTPS** origins and register `https://YOUR_HUB/api/auth/google/callback` with Google. Production account configuration rejects HTTP origins. Configure and publish/verify Google's consent application as required for the intended audience.

The hub requires Node24+ and a persistent writable SQLite volume. Set `ACCOUNTS_DB_PATH` to an absolute private path outside `public/`; back it up consistently with its WAL. Encore and Double or Drop separately need persistent game storage. Audio-source permissions remain independent of Google authentication.

Ephemeral serverless local disks cannot support this adapter. Use a persistent host or replace the central store with a shared database before scaling across hosts. Keep service secrets private, use TLS and hosting-level rate limits. No hosting, Google Cloud project, real credentials or remote database is provisioned by this code.

Apps use `file:../shared/accounts`. Install/build from the workspace checkout with this package available; Next configuration traces/transpiles the workspace dependency. Shared account UI lives in [shared/account-ui](../account-ui), with checked-in app copies. Run `node scripts/sync-account-ui.mjs --check` from the workspace root to verify consistency.

## Validation

Run `npm run test:accounts` in the hub for OAuth, redirects, isolation, logout, deduplication and atomic progress tests. Game tests verify account-bound progression, switching and outbox retry. Browser tests use private SQLite fixtures or mocked presentation data, never an exposed login bypass.

Actual Google sign-in still requires real configured credentials and user interaction. Local test results do not claim Google's external consent flow has been completed.
