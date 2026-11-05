// The game exchanges the hub session for its own secure local session.
export function gameAccountHref(url: string, signedIn: boolean) {
  return signedIn ? `${url.replace(/\/$/, "")}/api/account/login?returnTo=%2F` : url;
}
