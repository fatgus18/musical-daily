import type { Metric } from "./catalog-types.ts";

/** All four current reveal formats use whole numbers (duration uses whole seconds). */
export function comparableMetricValue(_metric: Metric, value: number): number {
  return Math.round(value);
}
