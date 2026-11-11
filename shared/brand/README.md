# Musical Daily brand

All five independently deployed apps use the same outlined SVG: a lime equalizer and warm-white Musical Daily wordmark. The SVG needs no remote font and keeps its color and shape inside every game's theme.

Edit the source files in this folder, then run from the workspace root:

```sh
node scripts/sync-brand.mjs
node scripts/sync-brand.mjs --check
```

The sync command copies the logo, accessible home navigation component, and responsive styles into each app. Copies are checked in, so deploying one app requires neither a parent workspace nor symlinks. Run the check command in workspace CI to detect drift.

Each game supplies its configured `NEXT_PUBLIC_HUB_URL`; the hub supplies `/`. The secondary “All games” link is visible on wider screens. On mobile the same logo remains a keyboard-accessible home link, leaving room for game controls.

## Game icons

The four games use a matching rounded-square icon family: lime spade, coral
equalizer, mint record, and lilac 2×. Each game's `src/app/icon.svg` is the
editable source. After changing one, regenerate the browser PNG fallback and
Apple home-screen icon from the workspace root:

```sh
node scripts/sync-game-icons.mjs
node scripts/sync-game-icons.mjs --check
```

Next.js file metadata supplies versioned, service-prefixed icon links on both
game and stats routes. Keep the starter `favicon.ico` removed so it cannot
compete with the game icon.
