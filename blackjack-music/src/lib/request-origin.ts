/** The service gateway preserves Host, while Next may expose its internal URL. */
export function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const value = request.headers.get("origin");
  // Non-browser API clients do not always send Origin. An opaque or empty
  // Origin is present, however, and must not be treated as a trusted client.
  if (value === null) return true;
  try {
    const source = new URL(value);
    if (!["http:", "https:"].includes(source.protocol) || source.origin !== value) return false;
    const target = new URL(request.url);
    const host = request.headers.get("host")?.toLowerCase();
    if (host === undefined) return source.origin === target.origin;
    if (source.host !== host) return false;
    // Keep the protocol check when the URL is already public. With an
    // internal service URL, Host is the public authority; never trust a
    // caller-supplied Forwarded or X-Forwarded-Host header instead.
    return target.host !== host || source.protocol === target.protocol;
  } catch { return false; }
}
