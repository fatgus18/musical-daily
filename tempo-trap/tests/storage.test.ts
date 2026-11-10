import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDaily, storageKey } from "../src/lib/storage.ts";
import type { Puzzle } from "../src/lib/types.ts";

test("rollover retains legacy date keys and delayed prior-day completions cannot rewind stats", () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const puzzle = { mode: "daily", date: "2026-11-09" } as Puzzle;
    assert.equal(storageKey(puzzle), "tempo:daily:2026-11-09");
    assert.equal(storageKey(puzzle, "listener"), "account:listener:tempo:daily:2026-11-09");
    values.set(storageKey(puzzle), "previous mix preserved");
    recordDaily("2026-11-08", 3000);
    recordDaily("2026-11-10", 4000);
    const stats = recordDaily("2026-11-09", 3500);
    assert.equal(stats.played, 3);
    assert.equal(stats.streak, 3);
    assert.equal(stats.lastDate, "2026-11-10");
    assert.equal(stats.totalScore, 10500);
    assert.deepEqual(stats.history.map(item => item.date), ["2026-11-08", "2026-11-09", "2026-11-10"]);
    assert.deepEqual(recordDaily("2026-11-09", 5000), stats);
    assert.equal(values.get(storageKey(puzzle)), "previous mix preserved");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
