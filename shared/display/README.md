# Display preferences

The hub and four games share the **Contrast** control beside their sound controls.
High contrast uses solid surfaces, brighter secondary text, stronger borders and
visible keyboard focus. Each app supplies its own gameplay overrides; common
account, statistics and control styles live here.

An explicit preference is saved in `md_contrast` (a host-only, one-year cookie)
and `musical-daily:contrast:v1` (local storage). The cookie shares the choice
across localhost ports and production routes on the same hostname. Separate
hostnames do not share this cookie. No account or music data is stored.

Without an explicit choice, `prefers-contrast: more` supplies the default. The
head bootstrap applies it before paint. Focus, visibility and history restore
events pick up changes made in another app. Storage restrictions never prevent
the control from changing the current page. Animations respect the operating
system's reduced-motion preference.

After editing the canonical sources, run from the workspace root:

```sh
node scripts/sync-display.mjs
node scripts/sync-display.mjs --check
```

The shared sound toolbar imports `ContrastToggle`; keep both display and sound
copies synced. Each root layout imports `display.css` after its own visual
styles and includes `contrastBootstrap` in the document head. The HTML element
uses `suppressHydrationWarning` because the bootstrap owns `data-contrast`.
