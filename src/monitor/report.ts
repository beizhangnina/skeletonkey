/**
 * The weekly Markdown report (ND-5): redacted account-by-account status, for
 * a human to skim and for `monitor report` to print back. Everything here
 * passes through a `Redactor` seeded with every vault value touched this run
 * plus the shape rules, before it ever reaches disk -- see `src/monitor/run.ts`.
 */
import type { Redactor } from "../redact.js";
import { redactShapes } from "../redact.js";
import type { AccountCheckResult, NormalizedUsage } from "./types.js";

export interface MonitorReportInput {
  generatedAt: string;
  accounts: AccountCheckResult[];
  /** What happened to the one notification this run might send, in one line. */
  notificationLine: string;
  /** One line per threshold that fell back to its default; see `resolveMonitorThresholds`. */
  thresholdWarnings?: string[];
}

function usageLine(usage: NormalizedUsage | null): string {
  if (usage === null) return "usage: unknown";
  const parts = [
    `used=${usage.used ?? "null"}`,
    `limit=${usage.limit ?? "null"}`,
    `remaining=${usage.remaining ?? "null"}`,
    `unit=${usage.unit ?? "null"}`,
    `period=${usage.period ?? "null"}`,
  ];
  return `usage: ${parts.join(", ")}`;
}

function accountSection(account: AccountCheckResult): string {
  const lines = [
    `## ${account.name} (${account.vendor})`,
    "",
    `- status: ${account.status}${account.isAlert ? " **[ALERT]**" : ""}`,
    `- email: ${account.emailHint ?? "(none on file)"}`,
  ];
  if (account.status !== "skipped") {
    lines.push(`- ${usageLine(account.usage)}`);
    if (account.httpStatus !== null) lines.push(`- http_status: ${account.httpStatus}`);
  }
  for (const reason of account.reasons) lines.push(`- ${reason}`);
  if (account.loginBillingNote !== null) lines.push(`- ${account.loginBillingNote}`);
  return lines.join("\n");
}

export function renderMonitorReport(input: MonitorReportInput, redactor: Redactor): string {
  const alertCount = input.accounts.filter((account) => account.isAlert).length;
  const header = [
    `# SkeletonKey weekly check -- ${input.generatedAt}`,
    "",
    `Accounts checked: ${input.accounts.length}. Alerts: ${alertCount}.`,
    `Notification: ${input.notificationLine}`,
    ...(input.thresholdWarnings ?? []).map((warning) => `Warning: ${warning}`),
    "",
  ].join("\n");
  const body = input.accounts.map(accountSection).join("\n\n");
  const text = `${header}\n${body}\n`;
  // Known values first (what was actually fetched this run), then shapes, as a
  // second pass -- belt and suspenders in case a vendor body slipped a value
  // past its parser untouched.
  return redactShapes(redactor.redact(text));
}
