export interface RemixRecord { id: string; streams: number }

export function remixTotal(records: RemixRecord[], selected: string[]) {
  const ids = new Set(selected);
  return records.reduce((total, record) => total + (ids.has(record.id) ? record.streams : 0), 0);
}

/** The finished nine-card board is small enough to inspect every combination.
 * Among equally good hands, a nudge prefers the fewest edits to your own mix. */
export function nearestBestHand(records: RemixRecord[], target: number, selected: string[]) {
  if (!Number.isSafeInteger(target) || target <= 0 || records.length > 12 ||
      new Set(records.map(record => record.id)).size !== records.length ||
      records.some(record => !Number.isSafeInteger(record.streams) || record.streams <= 0)) return null;
  const current = new Set(selected.filter(id => records.some(record => record.id === id)));
  let bestSum = 0, bestEdits = Infinity, bestIds: string[] = [];
  for (let mask = 1; mask < 2 ** records.length; mask++) {
    const ids = records.filter((_, index) => mask & (1 << index)).map(record => record.id);
    const sum = remixTotal(records, ids);
    if (!Number.isSafeInteger(sum) || sum > target) continue;
    const edits = ids.filter(id => !current.has(id)).length + [...current].filter(id => !ids.includes(id)).length;
    if (sum > bestSum || (sum === bestSum && edits < bestEdits)) { bestSum = sum; bestEdits = edits; bestIds = ids; }
  }
  return { total: bestSum, ids: bestIds };
}
