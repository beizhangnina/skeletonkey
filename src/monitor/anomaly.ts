/**
 * Usage-anomaly detection (ND-5): compares the official usage delta since the
 * last run against what the local ledger implies, and flags a big weekly drop
 * in `remaining`. Pure and synchronous, so it is trivially unit-testable.
 */
import type { ResolvedMonitorThresholds } from "./thresholds.js";
import type { NormalizedUsage } from "./types.js";

export interface LedgerWindowStats {
  calls: number;
  /** Sum of reported cost over the window, or null when nothing reported one. */
  cost: number | null;
}

export interface AnomalyVerdict {
  isAnomaly: boolean;
  reasons: string[];
}

/**
 * The ledger's best proxy for "how much official usage this should have
 * produced": reported spend when the vendor bills in USD and the ledger has
 * some, else the raw call count.
 */
function ledgerImplied(usage: NormalizedUsage, ledger: LedgerWindowStats): number {
  if (usage.unit === "USD" && ledger.cost !== null) return ledger.cost;
  return ledger.calls;
}

export function detectAnomaly(
  current: NormalizedUsage | null,
  previous: NormalizedUsage | null,
  ledger: LedgerWindowStats,
  thresholds: ResolvedMonitorThresholds,
): AnomalyVerdict {
  const reasons: string[] = [];
  if (current === null) return { isAnomaly: false, reasons };

  if (previous !== null && current.used !== null && previous.used !== null) {
    const officialDelta = current.used - previous.used;
    if (officialDelta > 0) {
      const implied = ledgerImplied(current, ledger);
      const bound = Math.max(
        thresholds.anomalyMultiplier * implied,
        implied + thresholds.anomalyAbsoluteThreshold,
      );
      if (officialDelta > bound) {
        reasons.push(
          `usage_anomaly: official usage rose by ${officialDelta} ${current.unit ?? "unit(s)"} since ` +
            `the last run, vs a ledger-implied ${implied} over the same window (threshold ${bound})`,
        );
      }
    }
  }

  if (
    previous !== null &&
    current.remaining !== null &&
    previous.remaining !== null &&
    previous.remaining > 0
  ) {
    const dropPct = ((previous.remaining - current.remaining) / previous.remaining) * 100;
    if (dropPct > thresholds.remainingDropPctThreshold) {
      reasons.push(
        `usage_anomaly: remaining dropped by ${dropPct.toFixed(1)}% this week ` +
          `(threshold ${thresholds.remainingDropPctThreshold}%)`,
      );
    }
  }

  return { isAnomaly: reasons.length > 0, reasons };
}
