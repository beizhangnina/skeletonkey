import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureHome } from "./config.js";
import { skeletonKeyHome, ledgerPath } from "./paths.js";
import type { LedgerRow } from "./types.js";

export interface LedgerEntry {
  alias: string | null;
  domain: string;
  timestamp?: string;
  status: number | null;
  bytes: number;
  /** Null unless the upstream actually told us what the call cost. */
  cost?: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  alias     TEXT,
  domain    TEXT    NOT NULL,
  timestamp TEXT    NOT NULL,
  status    INTEGER,
  bytes     INTEGER NOT NULL DEFAULT 0,
  cost      REAL
);
CREATE INDEX IF NOT EXISTS calls_timestamp_idx ON calls (timestamp);
CREATE INDEX IF NOT EXISTS calls_alias_idx ON calls (alias);
`;

export interface LedgerSummary {
  alias: string | null;
  calls: number;
  bytes: number;
  /**
   * Sum of the costs upstreams actually reported, or null when none did. Never
   * an estimate -- see README on why `cost` is mostly NULL.
   */
  cost_usd: number | null;
  /** How many rows carried no cost at all. */
  calls_without_cost: number;
  first_call: string | null;
  last_call: string | null;
}

/** Append-only log of proxied calls. One row per request, no payloads, no secrets. */
export class Ledger {
  private readonly db: DatabaseSync;

  constructor(file: string = ledgerPath()) {
    const dir = path.dirname(file);
    ensureHome(dir);
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort: the parent directory is already 0700.
    }
  }

  record(entry: LedgerEntry): number {
    const statement = this.db.prepare(
      `INSERT INTO calls (alias, domain, timestamp, status, bytes, cost)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = statement.run(
      entry.alias,
      entry.domain,
      entry.timestamp ?? new Date().toISOString(),
      entry.status,
      Math.max(0, Math.trunc(entry.bytes)),
      entry.cost ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  recent(limit = 20, alias?: string | null): LedgerRow[] {
    const bounded = Math.max(1, Math.trunc(limit));
    const rows =
      alias === undefined || alias === null
        ? this.db.prepare(`SELECT * FROM calls ORDER BY id DESC LIMIT ?`).all(bounded)
        : this.db
            .prepare(`SELECT * FROM calls WHERE alias = ? ORDER BY id DESC LIMIT ?`)
            .all(alias, bounded);
    return rows.map(toRow);
  }

  /** Call count, bytes, and reported spend, for one alias or for everything. */
  summary(alias?: string | null): LedgerSummary {
    const sql = `SELECT COUNT(*) AS calls,
                        COALESCE(SUM(bytes), 0) AS bytes,
                        SUM(cost) AS cost_usd,
                        SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS no_cost,
                        MIN(timestamp) AS first_call,
                        MAX(timestamp) AS last_call
                 FROM calls`;
    const row =
      alias === undefined || alias === null
        ? (this.db.prepare(sql).get() as Record<string, unknown>)
        : (this.db.prepare(`${sql} WHERE alias = ?`).get(alias) as Record<string, unknown>);
    const cost = row?.["cost_usd"];
    return {
      alias: alias ?? null,
      calls: Number(row?.["calls"] ?? 0),
      bytes: Number(row?.["bytes"] ?? 0),
      cost_usd: cost === null || cost === undefined ? null : Number(cost),
      calls_without_cost: Number(row?.["no_cost"] ?? 0),
      first_call: typeof row?.["first_call"] === "string" ? (row["first_call"] as string) : null,
      last_call: typeof row?.["last_call"] === "string" ? (row["last_call"] as string) : null,
    };
  }

  all(): LedgerRow[] {
    return this.db.prepare(`SELECT * FROM calls ORDER BY id ASC`).all().map(toRow);
  }

  /** Most recent successful-or-not call timestamp per alias. */
  lastUsedByAlias(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT alias, MAX(timestamp) AS last_used FROM calls WHERE alias IS NOT NULL GROUP BY alias`,
      )
      .all();
    const map = new Map<string, string>();
    for (const row of rows) {
      const alias = row["alias"];
      const lastUsed = row["last_used"];
      if (typeof alias === "string" && typeof lastUsed === "string") map.set(alias, lastUsed);
    }
    return map;
  }

  close(): void {
    this.db.close();
  }
}

export function openLedger(home = skeletonKeyHome()): Ledger {
  return new Ledger(ledgerPath(home));
}

function toRow(row: Record<string, unknown>): LedgerRow {
  return {
    id: Number(row["id"]),
    alias: typeof row["alias"] === "string" ? row["alias"] : null,
    domain: typeof row["domain"] === "string" ? row["domain"] : "",
    timestamp: typeof row["timestamp"] === "string" ? row["timestamp"] : "",
    status: row["status"] === null || row["status"] === undefined ? null : Number(row["status"]),
    bytes: Number(row["bytes"] ?? 0),
    cost: row["cost"] === null || row["cost"] === undefined ? null : Number(row["cost"]),
  };
}
