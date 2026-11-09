// The game exchanges the hub session for its own secure local session.
export function gameAccountHref(url: string, signedIn: boolean, returnTo = "/") {
  const base = url.replace(/\/$/, "");
  return signedIn ? `${base}/api/account/login?returnTo=${encodeURIComponent(returnTo)}` : returnTo === "/" ? url : `${base}${returnTo}`;
}
