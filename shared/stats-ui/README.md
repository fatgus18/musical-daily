# Shared game stats

The hub and all four games render this same account stats screen. The hub shows all four cards; each game's `/stats` page shows its own card, recent plays and a link back to the combined collection.

- Edit `music-stats.tsx` and `music-stats.css` here, then run `node scripts/sync-stats-ui.mjs` from the workspace root.
- Check synchronized copies with `node scripts/sync-stats-ui.mjs --check`.
- The route imports the stylesheet; no game layout or game stylesheet is required.
- Data always comes from that app's same-origin `/api/account/stats` endpoint. The shared account server remains the authoritative source.
- A changed account remounts its resource, aborts the previous request and checks the returned user ID. Guest cards show dashes rather than inventing account totals. Existing per-game guest history remains in the game's own storage.
- Play links from the hub use the established account handoff; the four standalone game pages link directly back to their local game.
- Run `npx playwright test --config playwright.stats.config.ts` from the Double or Drop app to verify all five surfaces, empty states, identity isolation and responsive layout.

Encore and Double or Drop show finished and incomplete counts separately, including accounts with no completed runs yet. Recent history labels both statuses and explains why an incomplete run ended. Accuracy includes every answered question from either status; unanswered questions never enter the denominator. Double or Drop's bank totals and **Best bank** include protected points from incomplete runs, while **Finished with points** only counts completed runs. Incomplete plays do not award wins, perfect mixes, or completion streaks. Guest histories remain in the game's own store and can be claimed on sign-in; account stats pages do not invent guest totals.
