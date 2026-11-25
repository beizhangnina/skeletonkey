/**
 * Safe defaults for the anomaly thresholds `skeletonkey monitor run` (ND-5)
 * judges usage against, and the `monitor:` config section that overrides them.
 * See `docs/monitor.md` for what each one means in practice.
 */
import type { Config } from "../types.js";

export const DEFAULT_ANOMALY_MULTIPLIER = 2;
export const DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD = 5;
export const DEFAULT_REMAINING_DROP_PCT_THRESHOLD = 50;

export interface ResolvedMonitorThresholds {
  anomalyMultiplier: number;
  anomalyAbsoluteThreshold: number;
  remainingDropPctThreshold: number;
  /**
   * One line per threshold that was configured but out of range and so fell
   * back to its default. Omitted entirely (not an empty array) when every
   * configured threshold was usable, so a config with no `monitor:` section
   * keeps comparing equal to the bare defaults.
   */
  warnings?: string[];
}

/**
 * Chosen behaviour: FALL BACK TO THE DEFAULT (not reject). Any value <= 0,
 * non-finite, or below the per-threshold floor is replaced by the default.
 *
 * A threshold of 0 (or negative) would make almost any usage look anomalous
 * -- `anomalyMultiplier: 0` makes the bound `0`, so any positive delta
 * alerts; a negative `remainingDropPctThreshold` alerts on every run. Rather
 * than reject a config like that outright (a typo should not stop the whole
 * monitor from running), each threshold below its floor falls back to the
 * safe default, with a one-line warning surfaced in the report so the typo
 * does not go unnoticed.
 */
const FLOORS = {
  anomalyMultiplier: 1,
  anomalyAbsoluteThreshold: 0,
  remainingDropPctThreshold: 0,
} as const;

function resolve(
  configured: number | undefined,
  floor: number,
  fallback: number,
  label: string,
  warnings: string[],
): number {
  if (configured === undefined) return fallback;
  // 0, negative, below-floor, and non-finite (NaN/Infinity/non-number) all
  // fall back: a threshold of exactly 0 is as broken as a negative one.
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0 || configured < floor) {
    warnings.push(
      `monitor.${label} (${String(configured)}) must be a number > 0 and >= ${floor}; using the default (${fallback}) instead`,
    );
    return fallback;
  }
  return configured;
}

export function resolveMonitorThresholds(config: Config | null): ResolvedMonitorThresholds {
  const monitor = config?.monitor;
  const warnings: string[] = [];
  const resolved: ResolvedMonitorThresholds = {
    anomalyMultiplier: resolve(
      monitor?.anomaly_multiplier,
      FLOORS.anomalyMultiplier,
      DEFAULT_ANOMALY_MULTIPLIER,
      "anomaly_multiplier",
      warnings,
    ),
    anomalyAbsoluteThreshold: resolve(
      monitor?.anomaly_absolute_threshold,
      FLOORS.anomalyAbsoluteThreshold,
      DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD,
      "anomaly_absolute_threshold",
      warnings,
    ),
    remainingDropPctThreshold: resolve(
      monitor?.remaining_drop_pct_threshold,
      FLOORS.remainingDropPctThreshold,
      DEFAULT_REMAINING_DROP_PCT_THRESHOLD,
      "remaining_drop_pct_threshold",
      warnings,
    ),
  };
  if (warnings.length > 0) resolved.warnings = warnings;
  return resolved;
}
