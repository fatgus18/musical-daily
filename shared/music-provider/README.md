# Shared music discovery

Encore and Double or Drop use the same artist search, owned-recording lookup, release traversal, stream identity matching, portraits, provider pacing and bounded metadata cache. Encore keeps compatibility re-exports from its existing library paths; game-specific scoring stays in each game.

Set the same absolute `MUSIC_PROVIDER_CACHE_PATH` for both Node processes when they share a host and persistent volume. During local development this can point at the existing `artist-encore/data/runtime/catalog.sqlite`. If unset, each app uses its own `data/runtime/catalog.sqlite`; discovery still works, but the cache and provider pacing are separate. `ENCORE_CATALOG_CACHE_PATH` remains supported for existing deployments.

The cache is disposable provider metadata, capped by bytes, entry count and entry size. It is separate from player saves. Live artist discovery returns coverage and a continuation cursor through the shared pool loader; partial/provider-limited results remain explicit. Returned US provider releases are not a guarantee of every song ever recorded. Missing play counts remain unknown, and a song never acquires fabricated streams or BPM.

Both applications must be built from the repository so Next can trace these source modules. Keep each app's existing workspace tracing root. No provider credentials or audio files are copied into this directory.
