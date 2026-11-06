// Public mounts are build-time configuration. Internal binding URLs are runtime-only.
export const servicePaths = Object.freeze({
  "musical-daily": "",
  "blackjack-music": "/blackjack",
  "tempo-trap": "/tempo-trap",
  "artist-encore": "/encore",
  "double-or-drop": "/double-or-drop",
});

export function serviceEnvironment(name, environment = process.env) {
  if (!Object.hasOwn(servicePaths, name)) throw new Error(`Unknown service: ${name}`);
  return {
    ...environment,
    NEXT_PUBLIC_BASE_PATH: servicePaths[name],
    NEXT_PUBLIC_MUSICAL_DAILY_SERVICES: "1",
    // This deployment is the requested guest preview. Authentication stays off.
    NEXT_PUBLIC_GUEST_ONLY: "1",
    NEXT_PUBLIC_HUB_URL: "/",
    NEXT_PUBLIC_BLACKJACK_URL: servicePaths["blackjack-music"],
    NEXT_PUBLIC_TEMPO_TRAP_URL: servicePaths["tempo-trap"],
    NEXT_PUBLIC_ENCORE_URL: servicePaths["artist-encore"],
    NEXT_PUBLIC_DOUBLE_DROP_URL: servicePaths["double-or-drop"],
  };
}
