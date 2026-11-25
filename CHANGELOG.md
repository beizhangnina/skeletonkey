# Changelog

All notable changes to `@dormy/skeletonkey`. Dates are America/New_York.

## 0.4.0 — unreleased (prepared 2026-11-24; publish is triggered by a human)

### Added
- **Local account vault — `skeletonkey account add | list | show | disable | enable`** (ND-1).
  Account metadata (`accounts.yaml`) is kept apart from secrets; only masked
  email hints and `vault://` references are ever written or printed. The email
  comes from a hidden prompt or `--email-stdin`; `--email <value>` is refused
  (exit 64). Read-only MCP tool `list_accounts`.
- **Vault entries + `skeletonkey run --env NAME=vault://entry[.field] -- <cmd>`**:
  injects a secret into one child process and redacts it from the child's
  output.
- **Guided signup — `skeletonkey signup list | start | status | complete | abandon`**
  (ND-2) for Apify, SerpApi, Firecrawl, Exa, GitHub and Apollo. `start` opens
  the vendor's own signup page and always reports `needs_human` (captcha,
  terms, payment stay with a person); `complete` binds the key through a
  hidden prompt. Read-only MCP tool `signup_status`.
- **Weekly monitor — `skeletonkey monitor run | report | install-help`** (ND-5):
  checks each account against the vendor's own usage API, compares it with the
  local ledger, and alerts through a local OS notification plus a redacted
  weekly report. Never installs a schedule. Read-only MCP tool
  `monitor_status`. Exit `78` (`monitor_alert`) when anything needs a human.
- **Index: `usage_api`** facts on rows (ND-4), structured core fields
  (`endpoints`, `auth`, `pricing`, `official_docs_url`; ND-8) and collection
  scope / visibility (ND-7).
- README: five-step quick start.

### Security
- Monitor: keys are sent over https only, to the one hardcoded official host;
  a cross-host redirect is a hard `error` (the other host is never contacted);
  state file, `--json` and `monitor_status` are redacted; unparseable 2xx
  responses are `parse_error`, not `ok`; hourly-reset counters (GitHub
  `/rate_limit`) are not compared week over week; alert thresholds of `0` or
  less fall back to the defaults with a warning (ND-6 findings).
- Signup/accounts: a 13–19 digit Luhn-valid value offered as a key is refused
  and never stored or echoed (exit `76` `card_number_rejected`; the signup
  stays `needs_human`); `--email=<value>` on `signup` is refused; unknown
  options never echo a value after `=` (ND-3 findings).
- A vault that cannot be decrypted (wrong `SKELETONKEY_PASSPHRASE`) now exits
  `68` (`vault_locked`) on every command, not `1`.

### New exit codes
- `76` `card_number_rejected`, `78` `monitor_alert`.

## 0.3.0

First npm release as `@dormy/skeletonkey`: trusted runner, approvals, spend
policy, secure input, redaction, domain allowlist, kill switch, `init` wizard
with Claude Code / Codex registration. See README "What v0.3 adds".
