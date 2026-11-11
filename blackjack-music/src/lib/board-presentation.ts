const GUEST_LAYOUT_KEY = "sbj_board_identity_v1";
let ephemeralGuestIdentity: string | undefined;

/** Never sent to the server: this key only chooses a guest's card layout. */
export function guestBoardIdentity(): string {
  try {
    const existing = localStorage.getItem(GUEST_LAYOUT_KEY);
    if (existing && /^[a-zA-Z0-9-]{8,128}$/.test(existing)) return `guest:${existing}`;
  } catch { /* Storage restrictions must not prevent playing. */ }

  ephemeralGuestIdentity ||= crypto.randomUUID();
  try { localStorage.setItem(GUEST_LAYOUT_KEY, ephemeralGuestIdentity); } catch { /* Stable for this page even without storage. */ }
  return `guest:${ephemeralGuestIdentity}`;
}

interface BoardIdentity {
  seedKey: string;
  catalogVersion: string;
  rulesVersion: string;
}

/**
 * A presentation-only permutation. The server's nine songs, cap, and solution
 * never depend on player identity; saved picks continue to reference song IDs.
 */
export function presentBoard<T extends { id: string }>(
  tracks: readonly T[], board: BoardIdentity, playerIdentity: string,
): T[] {
  const copy = [...tracks].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const key = JSON.stringify(["blackjack-layout-v1", board.seedKey, board.catalogVersion, board.rulesVersion, playerIdentity]);
  let seed = 2166136261;
  for (let index = 0; index < key.length; index++) seed = Math.imul(seed ^ key.charCodeAt(index), 16777619) >>> 0;
  for (let index = copy.length - 1; index > 0; index--) {
    let random = seed += 0x6d2b79f5;
    random = Math.imul(random ^ (random >>> 15), random | 1);
    random ^= random + Math.imul(random ^ (random >>> 7), random | 61);
    const other = Math.floor((((random ^ (random >>> 14)) >>> 0) / 4294967296) * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
