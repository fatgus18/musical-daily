// Shared source. Run `node scripts/sync-routing.mjs` from the workspace root.
// Next.js inlines public variables at build time. Keep these direct reads.
export const appBasePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

/** Prefix browser fetches, native anchors, and public assets; Next Link does this itself. */
export function withBasePath(path: string): string {
  if (!appBasePath || !path.startsWith("/") || path.startsWith("//")) return path;
  if (path === appBasePath || path.startsWith(`${appBasePath}/`) || path.startsWith(`${appBasePath}?`) || path.startsWith(`${appBasePath}#`)) return path;
  return `${appBasePath}${path}`;
}

/** A cross-service link: do not pass this through withBasePath or Next Link. */
export function hubHref(): string {
  return process.env.NEXT_PUBLIC_HUB_URL || "http://localhost:3001";
}
