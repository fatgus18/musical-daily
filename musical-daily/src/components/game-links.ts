// Services share the hub cookie. Navigation must not depend on a login handoff.
export function gameAccountHref(url: string, signedIn: boolean, returnTo = "/") {
  const base = url.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_MUSICAL_DAILY_SERVICES === "1") return returnTo === "/" ? url : `${base}${returnTo}`;
  return signedIn ? `${base}/api/account/login?returnTo=${encodeURIComponent(returnTo)}` : returnTo === "/" ? url : `${base}${returnTo}`;
}
