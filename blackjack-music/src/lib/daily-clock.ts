/** One daily challenge worldwide, regardless of sign-in or browser timezone. */
export function dailyDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nextDailyReset(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}
