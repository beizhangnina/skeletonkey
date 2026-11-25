# The weekly monitor (ND-5)

`skeletonkey monitor run` checks every active ND-1 account against its
vendor's **own** usage API (when one is documented and SkeletonKey ships a
checker for it), compares the delta against what the local ledger implies,
and writes a redacted Markdown report. It never installs a schedule itself —
see [Scheduling it yourself](#scheduling-it-yourself).

## Commands

```
skeletonkey monitor run [--account <name>] [--json] [--no-notify]
  [--report-dir <dir>] [--since <YYYY-MM-DD>] [--offline]
skeletonkey monitor report [--latest] [--json]
skeletonkey monitor install-help
```

- `monitor run` — checks every account that is not disabled (or just
  `--account <name>`), writes `~/.skeletonkey/monitor/state.json` and a
  Markdown report, and sends **one** OS notification if anything needs a
  human. `--no-notify` skips the notification but still writes the report.
  `--offline` makes no network call at all: every account is classified from
  what `state.json` already knows (useful for a dry run). `--since` compares
  official usage against a fixed date instead of the previous run.
- `monitor report [--latest] [--json]` — prints the most recent report's path
  and content. The content was already redacted when it was written.
- `monitor install-help` — **prints** example crontab / systemd-timer /
  launchd snippets for a weekly run. It does not install anything.

## What gets checked, and how

For each active account:

1. **Resolve the vendor's usage API.** The account's `vendor` is looked up in
   the API index (`apis.yaml` + `data/apis/*.yaml`) for its `usage_api` block
   (added in ND-4). `available: null` or `false` means "not verified in
   official docs" — the report says `cannot auto-compare usage: no official
   usage API verified` and nothing is flagged. `available: true` with no
   checker shipped for that vendor says so explicitly instead of guessing.
2. **Call it, if a checker exists.** The first-wave checkers
   (`src/monitor/checkers.ts`) cover Apify, SerpApi, Firecrawl, Apollo, Exa,
   and GitHub. Every checker sends the account's key to **exactly one**
   hardcoded host, over **https only**; the host *and* protocol of the index
   row's `usage_api.path` are checked against it before anything is sent, so
   an edited index can never redirect a key elsewhere or downgrade it to
   plain HTTP. If the official host itself answers with a cross-origin
   redirect, the default transport follows it (so a legitimate same-host
   redirect still works) but never forwards any header — `Authorization`,
   `x-api-key`, or otherwise — to a different origin; a key never leaves the
   official host. Exa's usage endpoint needs a distinct Team Management
   service credential — stored as a second vault entry named
   `<key_alias>-service` — and is skipped with a clear note when that entry
   does not exist.
3. **Classify the result:**
   - `ok` — a 2xx response that parsed to at least one usable field, nothing
     anomalous.
   - `invalid_key` — 401/403. If the previous run was `ok`, the report calls
     this out as a **sudden** 401.
   - `usage_anomaly` — see thresholds below.
   - `no_usage_api` — no verified usage API, or no checker for this vendor,
     or (Exa) no service key on file.
   - `parse_error` — a 2xx response whose body could not be turned into any
     usable field (not valid JSON, or valid JSON missing every field the
     checker looks for). Reported explicitly rather than as a silent `ok`, so
     a vendor changing its response shape does not look like "nothing to
     report".
   - `error` — a network failure, a non-2xx/3xx status, too many redirects,
     a non-https `usage_api.path`, or a host mismatch.
   - `skipped` — the account is disabled.
   `invalid_key`, `usage_anomaly`, `parse_error`, and `error` are **alerts**.
4. **Compare against the local ledger.** The official usage delta since the
   last run is compared against the ledger's call count (or reported spend,
   when the vendor bills in USD) for that key over the same window. A
   `remaining` that dropped by too much in a week is flagged too. A counter
   whose own `period` resets faster than the check interval (github's
   `/rate_limit`, `period: "hour"`) is excluded from both comparisons — its
   numbers are still reported, but a week-over-week delta on an hourly
   counter says nothing about weekly usage.
5. **Login/billing anomalies.** None of the first-wave checkers expose
   anything beyond usage, so every account's report section says so plainly:
   `login/billing anomaly check: not available via official API`. Nothing is
   invented here.

## Thresholds (`config.yaml`)

```yaml
monitor:
  anomaly_multiplier: 2
  anomaly_absolute_threshold: 5
  remaining_drop_pct_threshold: 50
```

All three are optional; the defaults above apply when the section (or any
field in it) is missing. A usage anomaly fires when the official delta
exceeds **both** `ledger_implied * anomaly_multiplier` and
`ledger_implied + anomaly_absolute_threshold` — the higher of the two bounds,
so a vendor with near-zero ledger traffic still needs a real jump (the
absolute threshold) rather than tripping on `2 * 0`. A `remaining` drop fires
when it falls by more than `remaining_drop_pct_threshold`% since the last run.

Each threshold has a floor below which it would make almost any usage look
anomalous: `anomaly_multiplier` must be `>= 1` (a multiplier of `0` makes the
bound `0`, so any positive delta would alert), and
`anomaly_absolute_threshold` / `remaining_drop_pct_threshold` must be `> 0`.
A configured value of `0`, a negative value, a value below its floor, or
anything that is not a finite number **falls back to
the default rather than being rejected** — a typo in `config.yaml` should not
stop the whole monitor from running — but the report's header gets a one-line
`Warning:` naming which setting was ignored and why.

## Files

- `~/.skeletonkey/monitor/state.json` (mode `0600`) — per-account last
  status, last normalized usage (`{used, limit, remaining, unit, period}`),
  and last run time. No secret ever goes in this file.
- `~/.skeletonkey/monitor/reports/weekly-YYYY-MM-DD.md` (mode `0600`, or
  under `--report-dir`) — the redacted report for one run.

Every line written to either file (and the notification body, the `--json`
output, and the MCP `monitor_status` tool) passes through a `Redactor` seeded
with every vault value this run actually touched, plus the shape-based rules
in `src/redact.ts` — including a generic rule for a key carried as a bare URL
path segment (`.../usage/<key>`, `.../limits/key/<key>`, the shape DefiLlama
and Semrush use), even though no checker ships for either of those vendors
yet. This covers more than the rendered report: a vendor that echoes the
account's own key back into a string field a checker keeps (seen in
practice: apify's `usageCycle.startAt` folding into `usage.period`) is
redacted before it is put in a result, `state.json`, or any JSON output —
not only when the Markdown report is rendered. `state.json` is additionally
re-sanitized (shape rules only) on every read, as a second layer against a
file written before this redaction was in place, or hand-edited.
`email_hint` is re-masked with the same `maskUsername` ND-1 uses if it does
not already look masked, so a hand-edited `accounts.yaml` cannot put a
plaintext email in a report either.

## Exit codes

`monitor run` reuses the shared table in `src/exit-codes.ts`:

| code | name            | meaning                                             |
| ---- | --------------- | ---------------------------------------------------- |
| 0    | `ok`            | every account is ok / no_usage_api / skipped          |
| 64   | `usage`         | a bad flag                                            |
| 65   | `no_home`       | `skeletonkey init` has not run                        |
| 68   | `vault_locked`  | the vault backend could not be opened                 |
| 78   | `monitor_alert` | at least one account is invalid_key/usage_anomaly/parse_error/error |

## What this does NOT check

- **Login anomalies** (a new device, a new location) — no first-wave vendor
  exposes this via an official API, so it is never checked, and the report
  says so instead of staying silent about it.
- **Billing anomalies** beyond usage/credits (an unexpected charge, a plan
  change) — same reason.
- Any vendor whose usage API is undocumented, or documented but without a
  checker here yet (`defillama`-style and `semrush`-style URL-embedded keys
  are redaction-only for now: SkeletonKey knows the shape well enough to keep
  it out of logs, but ships no checker for either).

## Scheduling it yourself

**SkeletonKey never installs a cron job, a systemd timer, or a launchd
agent.** `skeletonkey monitor install-help` prints ready-to-paste snippets for
all three — copy the one that fits your machine and install it yourself.

## MCP: `monitor_status`

A read-only tool returning the same per-account summary as `state.json`:
status, last run time, last normalized usage. It never runs a new check and
never contacts a vendor — only `skeletonkey monitor run` does that, and only
a human (or their own scheduler, from `install-help`) decides when.
