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
}

export function resolveMonitorThresholds(config: Config | null): ResolvedMonitorThresholds {
  const monitor = config?.monitor;
  return {
    anomalyMultiplier: monitor?.anomaly_multiplier ?? DEFAULT_ANOMALY_MULTIPLIER,
    anomalyAbsoluteThreshold: monitor?.anomaly_absolute_threshold ?? DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD,
    remainingDropPctThreshold:
      monitor?.remaining_drop_pct_threshold ?? DEFAULT_REMAINING_DROP_PCT_THRESHOLD,
  };
}
