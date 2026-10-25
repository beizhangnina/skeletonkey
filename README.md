# SkeletonKey — the master key for your agents

**Just-in-time API access, so your agents stop hitting walls.** An agent that
needs a paid API shouldn't stall waiting for you to go sign up, make a key, and
paste it somewhere. It asks SkeletonKey, gets access at the moment it needs it,
and calls the API through a proxy that attaches the credential on the way out.

A local-only vault for your own API keys, plus a loopback proxy that injects
them for you and an MCP server your agent can talk to. Your agents and scripts
call the proxy; the proxy holds the keys. Nothing is uploaded anywhere, there is
no account, and there is no server component.

Status: **v0.3 — zero-knowledge foundation.** TypeScript, Node 22+, MIT licensed. Repo:
[`beizhangnina/skeletonkey`](https://github.com/beizhangnina/skeletonkey) (public, MIT).

v0.3 adds the pieces that keep a secret away from the model entirely: a
**trusted runner** process that holds the secrets, **async approvals** the human
decides outside the agent's context, a **spend policy** that starts at $0, a
**Secure Input Popup** on localhost for the values that must never pass through
an AI, and a **kill switch** that stops the proxy and the runner at once. See
[What v0.3 adds](#what-v03-adds).

## Why

**You should not have to sign up for a key-aggregator service to let your agent
use a paid API.**

The current shape of that problem: you want your agent to scrape a site, or
embed a corpus, or read some social data. The agent needs a key. So you either
go and sign up yourself, create the key, and paste it into an `.env` file — or
you hand the whole problem to an aggregator that holds a credential on your
behalf and bills you for the privilege.

The alternative this repo is built around: **your own agent plus your own
key broker is enough.**

1. The agent **finds** the right API — `find_api("web scraping")` against a
   local index.
2. It gets **access just-in-time** — `request_access(...)` either hands back a
   proxy URL for a key you already have, or a signup plan the agent walks with
   its *own* browser and its *own* email connector. **A human confirms the final
   step**: payment and terms acceptance, always.
3. It **calls the API through the proxy** and never holds the key.

The key stays in your vault. The billing relationship stays yours. There is no
SkeletonKey account, no SkeletonKey server, and no network traffic other than the
upstream call your agent asked for.

The full statement of intent, with three worked end-to-end scenarios and an
honest per-step split of what v0.1 automates versus what a human still does, is
in [docs/v0.1-acceptance.md](docs/v0.1-acceptance.md).

## The problem it solves today

Once you start wiring personal automation to paid APIs, keys end up everywhere:

- pasted into `.env` files that get copied between projects and sometimes committed,
- exported in shell profiles, where every process you run can read them,
- handed to an agent or script that then has your raw credential for as long as it runs,
- forgotten: a key for a service you stopped using six months ago is still live and still billable.

The separate annoyance is bookkeeping. You cannot easily answer "which key did
that call use", "how many calls did this key make this week", or "which keys have
I not used at all".

SkeletonKey addresses both with four pieces:

1. **A vault** holding the secrets — Bitwarden, 1Password, your OS keychain, or an encrypted file.
2. **`keys.yaml`**, a metadata index with **no secret values** — alias, platform, domain, which header to inject, when it was created, when it was last used, whether it is disabled.
3. **A local proxy** that injects the right header by destination domain and writes one SQLite ledger row per call.
4. **An MCP server** so an agent can find APIs, request access, and read spend — with no tool that can return a key.

Your code never sees the key. It sends a request to `127.0.0.1` without any
credential, and the proxy attaches the credential on the way out.

## What v0.3 adds

The agent-facing surface is unchanged in spirit — it still cannot see a key —
but everything that *does* touch a secret now lives in a second process.

| Piece | What it is | Where |
| --- | --- | --- |
| **Trusted runner** | A separate process (`skeletonkey runner`, or the `skeletonkey-runner` binary) that holds the `bw` session, anything the ladder resolves, and anything typed into the Secure Input Popup. The MCP server talks to it over loopback with a token from `runner.json` and gets back opaque ids and statuses. Its API has **no verb that returns a secret value**. | `src/runner/` |
| **Async approvals** | `request_access` no longer waits on anything in the chat: the runner raises an OS notification (`notify-send` / `osascript`, best effort) plus a page at `http://127.0.0.1:8788/approve/<id>`. The agent gets `{request_id, status: "pending_approval"}` and polls `access_status`. | `src/requests.ts` |
| **Secret resolution ladder** | Bitwarden → bound inbox → Secure Input Popup, stopping at the first rung that answers, behind one interface per rung. `bw` is driven through `child_process` and is faked in the tests. | `src/secrets/` |
| **Bitwarden account lookup** | `init` and the first secret use detect whether `bw` is installed, logged in and unlocked, and whether it is logged in **as the bound email** — then print the exact commands the *human* runs (`bw login <bound email>`, `export BW_SESSION="$(bw unlock --raw)"`). Vendor accounts you made yourself are found by **bound email + vendor domain**. SkeletonKey never asks for, reads, or passes on your master password. | `src/vault/bw-account.ts` |
| **Secure Input Popup** | A localhost-only page for a card number, a CVV, a password, or an OTP. It shows the vendor domain and the **verified origin**, masks the field, and sends the value to the runner only — never to the agent, a log, or the page's own response. | `src/secrets/popup.ts` |
| **Domain allowlist** | Built from the API index plus the keys already in the vault. A secret is filled only on an allowlisted origin, over https; a lookalike domain is refused before any rung of the ladder is asked, and the human is told. | `src/allowlist.ts` |
| **Spend policy** | `policy.yaml`: one global monthly cap plus per-vendor caps, **both $0 by default with no preset numbers**. The first paid action raises an approval asking the human to set them. Caps move only from the approval page or `skeletonkey policy set`. | `src/policy.ts` |
| **Payment submit gate** | A `payment` approval carries an exact amount, and the caps are checked **twice**: once when the approval is raised, and again in the runner immediately before the submit, against a freshly read `policy.yaml` and a freshly read ledger. If a cap was lowered or the ledger grew in between, the submit is blocked, the stale approval is **voided**, and a new approval is raised for the human. v0.3 still submits nothing itself — the default submitter is a human handoff — but every future submit path has to come through this gate. | `src/payments.ts` |
| **`cancel_request`** | An agent may disable a key and cancel its own request. It may never enable a key or raise a cap — there is no tool, and no runner verb, that can. | `src/mcp.ts` |
| **Log redaction** | One utility applied to every log line, the ledger's text columns, the request store, and **every MCP response**. Two layers: values this process has loaded, plus secret *shapes* (card numbers by Luhn, `sk-`-style keys, bearer tokens, `password=` assignments). | `src/redact.ts` |
| **Kill switch** | `skeletonkey disable --all` disables every key, writes the flag both processes read, voids every pending approval, and closes any open Secure Input Popup. The proxy then answers `403 {"error":"kill_switch"}` locally. Only a human clears it, with `skeletonkey resume`. | `src/killswitch.ts` |
| **`init` auto-registration** | `skeletonkey init` registers the MCP server and installs the skill for **Claude Code and Codex only**, after showing the diff. Idempotent, and it never rewrites a config it cannot parse or an entry you wrote yourself. | `src/agents/register.ts` |

Deliberately **not** in v0.3:

- **No automated vendor signup.** `src/signup/types.ts` ships the interfaces and
  the honest default (every vendor is a human handoff). Playbooks for Apify,
  TikHub, Apollo and DropLeads land in v0.5.
- **No crypto rails.** Fiat only (D6). There is no stablecoin or wallet code
  anywhere here, and nothing pays for anything over a crypto rail. The index
  records no crypto-payment field, and the router has no crypto route to
  report — not even as an observation about a vendor. The route set is exactly
  `direct`, `aggregator:<name>` and `unknown`.
- **No virtual cards.** One card in Bitwarden, plus SkeletonKey's own caps and
  approvals.
- **No inbox reader yet.** The bound-inbox rung exists with its filter rules
  (vendor sender domain, time window) and reports "nothing is bound" until v0.5.
  It never asks the agent to read the mailbox in its place.

### Try v0.3 locally

Three terminals, no vendor account, no card, nothing published to npm:

```bash
git clone https://github.com/beizhangnina/skeletonkey.git
cd skeletonkey && npm install && npm run build

# 1. set up, and register with Claude Code / Codex (shows a diff first)
node dist/cli.js init --email apis@example.com --backend encrypted-file

# 2. the trusted runner: approvals, caps, secure input, secrets
node dist/cli.js runner
#   approvals:    http://127.0.0.1:8788/
#   agent API:    http://127.0.0.1:8788/v1/...  (token in ~/.skeletonkey/runner.json)

# 3. the proxy, as before
node dist/cli.js proxy
```

Then, as the agent would:

```bash
# No key for this vendor, so the runner raises an approval and hands back an id.
#   (through the MCP server in a real agent; this is the same code path)
node dist/cli.js requests        # what is waiting for you
node dist/cli.js policy show     # every cap is $0 until you say otherwise
```

Open `http://127.0.0.1:8788/` in a browser: the approval page shows the vendor,
the terms link, what is shared (the bound email), whether payment is expected,
and two cap fields with **no numbers filled in**. Approve it and the agent's
`access_status` turns into `needs_human` with the reason `no_playbook` — which is
the honest state of v0.3, and exactly what a captcha will look like in v0.5.

To see the kill switch:

```bash
node dist/cli.js disable --all   # every key off, approvals voided, proxy refuses
curl -s http://127.0.0.1:8787/api.openai.com/v1/models   # 403 kill_switch
node dist/cli.js resume          # human-only
```

## Install troubleshooting

One-line installs (`npx skeletonkey init`) work **after the npm release** — see
[Installing](#installing-from-source-today-npm-after-release). Until then, clone
and build. These are the things that actually go wrong:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SyntaxError: Unexpected token` on startup, or `node:sqlite` not found | **Node too old.** SkeletonKey needs **Node 22.5+** for the built-in `node:sqlite`. | `node --version`, then install Node 22.5 or newer (`nvm install 22`). The `engines` field refuses older versions on install. |
| `EACCES: permission denied, mkdir '/usr/local/lib/node_modules'` | A **global npm install** without permission to write the global prefix. | Do not install globally: run `npx skeletonkey init` (after release), or clone and use `node dist/cli.js`. If you want a global install, set a user prefix: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`. Never `sudo npm install -g`. |
| `Bitwarden is not ready: the `bw` CLI was not found on PATH` | The **Bitwarden CLI is not installed**. | Follow the install lines SkeletonKey prints (`npm install -g @bitwarden/cli`, `brew install bitwarden-cli`, `snap install bw`, or <https://bitwarden.com/help/cli/>), or run `skeletonkey init --backend encrypted-file`, which needs nothing. |
| `Bitwarden is not ready: ... not logged in` | `bw` is installed but **not logged in**. | `bw login <your bound email>` in your own terminal. SkeletonKey never logs in for you and never sees your master password. |
| `Bitwarden is not ready: ... logged in but locked` | Logged in but **locked**; the session is a human action. | `export BW_SESSION="$(bw unlock --raw)"` in the shell you run SkeletonKey from, then retry. The runner holds that session in memory only. |
| `` `bw` is logged in as ..., not the bound email ... `` | The vault is unlocked, but as a **different account** than `email:` in `config.yaml`. Vendor accounts are looked up by the bound email, so lookups would miss. | Either `bw logout` and `bw login <bound email>`, or change `email:` in `config.yaml` to the account you actually use. `skeletonkey bitwarden status` shows both sides. |
| `EADDRINUSE: address already in use 127.0.0.1:8787` | **Port 8787 is busy** (often an older `skeletonkey proxy`). | `lsof -nP -iTCP:8787 -sTCP:LISTEN` (or `ss -ltnp | grep 8787`) and stop it, or pick another port: `skeletonkey proxy --port 8799` and set `proxy.port` in `config.yaml`. The runner's own port is `8788`: `skeletonkey runner --port 8799`. |
| The ladder falls straight through to the popup | Expected when `bw` is **locked, missing, or has no card item**. The runner says which in its log. | Unlock `bw`, or store a card item named `skeletonkey: card`. The popup is the designed fallback, not a failure. |
| **MCP server not showing in Claude Code or Codex** | The config was written before the agent started, the agent was not restarted, or you registered into a different home. | Re-run **`skeletonkey register`** (or `skeletonkey init`), then restart the agent. `skeletonkey register --dry-run` prints exactly which files it would touch. Check `~/.claude.json` has `mcpServers.skeletonkey` and `~/.codex/config.toml` has `[mcp_servers.skeletonkey]`. Claude Code and Codex are the only supported agents. |
| `register` says "already defines [mcp_servers.skeletonkey]" and changes nothing | You (or `codex mcp add`) wrote that entry by hand. **Yours wins.** | Nothing to do, unless the command inside it is wrong — edit it yourself, or delete it and re-run `skeletonkey register`. |
| Approval page says "This page is served to localhost only" | Reached over a hostname that is not loopback (a tunnel, a reverse proxy). | Open it as `http://127.0.0.1:8788/...` on the same machine. The approval and secure-input pages are loopback-only by design. |
| Agent says `runner_unavailable` | The **runner is not running**; it is the only thing that can hold a secret or raise an approval. | `skeletonkey runner` (or `skeletonkey-runner`). The MCP server finds it through `~/.skeletonkey/runner.json`. |
| Every call returns `403 {"error":"kill_switch"}` | The **kill switch is engaged**. | `skeletonkey resume`, then `skeletonkey enable <alias>` for each key you want back. Two separate switches, on purpose. |

## Prerequisites

### Required

| | What | Notes |
| --- | --- | --- |
| **Node** | Node.js **22.5 or newer** | Uses the built-in `node:sqlite`, so there is no native module to compile. |
| **One vault backend** | **Bitwarden** (recommended) | Free tier covers **unlimited devices**, syncs across them, clients and server are **open source**, and you can **self-host with [Vaultwarden](https://github.com/dani-garcia/vaultwarden)** if you would rather not use their service at all. Install the [`bw` CLI](https://bitwarden.com/help/cli/) and `bw login`. This is the default in `skeletonkey init`. |
| | 1Password (optional) | If you already pay for it. Needs the [`op` CLI](https://developer.1password.com/docs/cli/), signed in. |
| | OS keychain (optional) | macOS login keychain via `security`, or a libsecret keyring on Linux via `secret-tool` (`apt install libsecret-tools` plus a running `gnome-keyring`). No account, but no sync either. |
| | Encrypted file (optional) | **Zero install.** An AES-256-GCM file under `SKELETONKEY_HOME`, unlocked by a passphrase. Pick this to try the tool in one command. |

That is the whole hard requirement list: a Node runtime and somewhere to put
secrets.

### Recommended, not required

- **A dedicated email with `+aliases`.** Something like `apis@yourdomain.com`,
  used only for API signups, so vendor mail, password resets, and billing
  notices stay out of your main inbox. `skeletonkey init` records it, and the
  assisted-signup flow uses a per-vendor alias
  (`apis+apify@yourdomain.com`) so you can tell at a glance who leaked your
  address and filter per vendor. Gmail, Fastmail, and most providers support
  `+aliases` out of the box. Works fine without one — you just lose the
  per-vendor sorting.

### Not needed in v0.3

- **A credit card.** v0.3 stores and injects keys, raises approvals, and holds
  caps; it still pays for nothing. When payments land (v1.0) it is **one card in
  your Bitwarden vault** plus SkeletonKey's own caps and per-action approvals —
  no virtual-card integration (D12), fiat only (D6). The card number is read by
  the runner and typed into the vendor's own checkout; it is never stored outside
  your vault and never passes through the agent. Today, if a provider wants
  money, you enter your own card on their site, by hand. The submit-time cap
  re-check that any future card flow has to pass is already in place
  (`src/payments.ts`).
- **Tailscale or any private network.** Only needed if you want **gateway
  mode** — one always-on host holding the keys for your laptop, phone, and
  anything else. A single-machine setup needs no network at all beyond the
  upstream API call.

## Local-only security model

What this tool does:

- **Everything stays on one machine** (or one tailnet, if you turn on gateway mode). No telemetry, no sync, no remote service. The only network traffic is the upstream API call you asked for.
- **Secrets live in a vault, never in metadata.** `keys.yaml`, the ledger, and all log output contain metadata only. A test asserts that no file under `SKELETONKEY_HOME` except the test-only plaintext vault ever contains the secret.
- **Secrets are not passed in argv.** `skeletonkey add` reads the secret from stdin or a non-echoing prompt. Vault helpers (`bw`, `op`, `security`, `secret-tool`) receive secrets on stdin or via a `0600` temp file, so secrets do not appear in `ps` output or shell history.
- **The proxy binds to `127.0.0.1` by default,** and refuses to bind `0.0.0.0` or `::` unless you pass `--allow-all-interfaces`. Any non-loopback bind prints a warning first. Treat the port exactly like a credential: anything that can reach it can spend through your keys.
- **Gateway mode requires a shared token.** `skeletonkey proxy --gateway` will not start without `gateway.token` / `SKELETONKEY_GATEWAY_TOKEN` / `--token` (or an explicit `--insecure-no-token`), and then requires it as `X-SkeletonKey-Token` on every request.
- **npm publish is intentionally disabled for now.** `package.json` sets `"private": true` so the package cannot be published to npm by accident. Install from source (clone, `npm install`, `npm run build`). The name `skeletonkey` is unclaimed on npm as of 2026-10-25.
- **Secrets live in the runner, not in the MCP process.** The trusted runner holds the `bw` session and every resolved value in memory; the MCP server reaches it over loopback with a token and can only ask for approvals and statuses. There is no "read secret" verb to call, which is also what a prompt injection would have to find.
- **Values that must never pass through an AI** — API keys, passwords, card numbers, CVVs — are collected by the runner's Secure Input Popup on localhost, or read straight from Bitwarden. An OTP is the one class §5a of the PRD allows an agent to see, and even then the runner reads it first when an inbox is bound.
- **Secrets are only filled on allowlisted origins.** The allowlist is built from the API index and the keys already in the vault; a lookalike domain is refused before any rung of the ladder is asked, and the human is notified.
- **Everything written is redacted.** One utility covers logs, the ledger's text columns, the request store, and every MCP response — known values plus secret shapes. A canary test pushes a fake key, password, card number and CVV through the real code paths and then greps every tool response, every page, every file under `SKELETONKEY_HOME`, and all CLI output for them.
- **Caps start at $0 and only a human moves them.** `policy.yaml` is written only by the approval page or `skeletonkey policy set`; an agent can disable a key and cancel a request, and nothing more.
- **An approval is not a blank cheque.** The caps are re-checked immediately before any payment is submitted, against a freshly read policy and a freshly read ledger — so an approval that was fine when the human clicked it is still blocked if a cap has since been lowered or the month's spend has since grown. The stale approval is voided and a new one is raised; an agent cannot spend past a cap by holding on to an old yes.
- **Client-supplied auth headers are stripped.** `authorization`, `proxy-authorization`, `x-api-key`, `api-key`, `x-auth-token`, `x-access-token`, `x-skeletonkey-token`, and the key's own header are removed from every request before the vault header is injected. A caller cannot smuggle its own credential through, cannot override yours, and the gateway token never reaches the upstream.
- **The MCP server cannot reveal a key.** There is no such tool, and a test calls every handler with a stored secret and asserts no response contains it. The only tool that touches a secret, `register_key`, does so by prompting the human on `/dev/tty` — out of band from the agent entirely.
- **Nothing is logged that could leak a key.** Log lines carry method, domain, path, status, byte count, and alias. As a backstop, the proxy redacts any secret it has loaded from any line it is about to print.
- **Files are tight by default.** `SKELETONKEY_HOME` is `0700`; `config.yaml`, `keys.yaml`, `vault.enc.json`, `dev-vault.json`, `ledger.db`, and v0.3's `policy.yaml`, `requests.json`, `runner.json` (which holds the runner's loopback token), `killswitch.json` and `runner.log` are all `0600`.
- **`CONNECT` is refused with 405.** A `CONNECT` tunnel is end-to-end TLS, so the proxy cannot inject into it. Rather than pass traffic through with no credential and look broken, it says no. This is why `HTTPS_PROXY` is not supported — see [Calling APIs through the proxy](#calling-apis-through-the-proxy).

What this tool does *not* do:

- It is **not** a secret manager for a team, and has no sharing, rotation, or audit story beyond your own ledger.
- It does **not** protect against malicious code already running as your user. Such code can just call the proxy. The vault backends raise the bar (Bitwarden locks, Keychain and 1Password can require your approval); nothing stops a process that can reach `127.0.0.1:8787`.
- It does **not** encrypt the ledger. The ledger holds domains, timestamps, statuses, and byte counts — no payloads, no secrets — but it is still a record of what you call.
- The `file` backend is **plaintext and test-only**. It is hidden from `skeletonkey init` and refused unless `SKELETONKEY_ALLOW_TEST_BACKEND=1` is set. The test suite and `scripts/demo.sh` are the only things that should ever use it.

### Backends

| Backend | Where secrets go | Needs | Notes |
| --- | --- | --- | --- |
| `bitwarden` **(default)** | Bitwarden login items named `skeletonkey: <alias>`, with the bound email as the item username | `bw` CLI, logged in and unlocked | Free tier, unlimited devices, syncs, open source, self-hostable via Vaultwarden. Export `BW_SESSION="$(bw unlock --raw)"` first; `skeletonkey bitwarden status` says what is missing. |
| `1password` | 1Password API Credential items titled `skeletonkey: <alias>` | `op` CLI, signed in | Optional; for people who already use it. |
| `keychain` | macOS login keychain (`security`), or libsecret (`secret-tool`) on Linux | OS keystore | No account, no sync. On Linux needs `libsecret-tools` and a running Secret Service. |
| `encrypted-file` | `$SKELETONKEY_HOME/vault.enc.json` — AES-256-GCM, key from scrypt over your passphrase | nothing | Zero install. Passphrase from `SKELETONKEY_PASSPHRASE` or a hidden prompt. Lose the passphrase, lose the keys. |
| `file` | `$SKELETONKEY_HOME/dev-vault.json`, mode `0600`, **plaintext** | nothing | **Test-only.** Hidden from `init`, refused without `SKELETONKEY_ALLOW_TEST_BACKEND=1`. |

The `bw`, `op`, `security`, and `secret-tool` backends depend on CLIs that are
not present on the Linux CI used to develop this MVP, so they are exercised by
hand rather than by the automated suite. `encrypted-file` and `file` are fully
covered by tests, including an assertion that the encrypted vault on disk does
not contain the plaintext secret.

## Installing: from source today, npm after release

SkeletonKey is **not published yet**: `package.json` still has `"private": true`
so it cannot be pushed to the registry by accident. The package name
**`skeletonkey` is free** on npm — `npm view skeletonkey name` returns `404 Not
Found`, checked 2026-10-25 — and v0.3 is otherwise publish-ready: `bin` entries
(`skeletonkey`, `skk`, `skeletonkey-runner`) and a `files` whitelist
(`dist`, `apis.yaml`, `data/apis`, `data/discovered.example.yaml`, `skills`,
`docs`, `README.md`, `LICENSE`) are in place.

**After the npm release** (v0.5, per the roadmap), these one-liners are the
install path (D9):

```bash
npx skeletonkey init                                       # set up + register both agents
claude mcp add skeletonkey -s user -- npx -y skeletonkey mcp   # Claude Code, by hand
# Codex equivalent: `codex mcp add`, or the [mcp_servers.skeletonkey] block below
```

**Today**, build from source:

```bash
git clone https://github.com/beizhangnina/skeletonkey.git
cd skeletonkey
npm install
npm run build
npm link            # optional: puts `skeletonkey`, `skk` and `skeletonkey-runner` on your PATH
```

If anything goes wrong, the [install troubleshooting table](#install-troubleshooting)
covers the usual causes (Node too old, `EACCES` on a global install, `bw` not
installed/not logged in/locked, port 8787 busy, MCP server not showing up).

## Quickstart

Every command below can be typed as `skk` instead of `skeletonkey` — the two
binaries are the same CLI.

Set up SkeletonKey. Use a **dedicated email** for API signups so that vendor
mail, password resets, and billing notices stay out of your main inbox:

```bash
skeletonkey init                                                   # interactive: asks for email and backend
skeletonkey init --email apis@example.com --backend bitwarden      # the default
skeletonkey init --email apis@example.com --backend encrypted-file # zero-install option
```

Add a key. The secret is read from stdin when piped, and from a hidden prompt otherwise:

```bash
skeletonkey add openai-personal --platform OpenAI --domain api.openai.com
# Secret (not echoed): ...

# or, piped:
printf '%s' "$MY_KEY" | skeletonkey add some-api \
  --platform SomeCo \
  --domain api.someco.example \
  --header Authorization \
  --format 'Bearer {key}'

# a header that is not a bearer token:
printf '%s' "$OTHER_KEY" | skeletonkey add other-api \
  --platform OtherCo --domain api.otherco.example \
  --header X-Api-Key --format '{key}'

# a vendor you really do reach over plain HTTP (a box on your own LAN):
printf '%s' "$LAB_KEY" | skeletonkey add lab-box \
  --platform LabBox --domain box.lab.internal --scheme http
```

Run the proxy and call through it:

```bash
skeletonkey proxy --port 8787
curl http://127.0.0.1:8787/api.openai.com/v1/models
```

Then look at what happened:

```bash
skeletonkey list              # metadata, never secrets
skeletonkey ledger            # recent calls: alias, domain, time, status, bytes, cost
skeletonkey idle --days 30    # keys you have not used in a month
skeletonkey disable old-api   # stop injecting: the proxy now answers 403 key_disabled itself
skeletonkey stale-check        # re-read every verified price page and flag what moved
```

### See it work without any real key

```bash
./scripts/demo.sh
```

The demo creates a throwaway `SKELETONKEY_HOME`, stores the fake key
`sk-demo-FAKE-123`, starts a local echo server and the proxy, curls through it
with a deliberately wrong client `Authorization` header, then shows that the
upstream received the injected header instead, that `keys.yaml` holds no secret,
and that the ledger got its row. It cleans up after itself.

## Calling APIs through the proxy

There are two ways to route a call, and only one of them works for HTTPS.

### Reverse / base-URL mode — recommended

Put the destination domain in the path, or point a client's base URL at the
proxy plus the domain:

```bash
curl http://127.0.0.1:8787/api.openai.com/v1/models
```

```bash
# Anything that takes an OpenAI-style base URL:
export OPENAI_BASE_URL=http://127.0.0.1:8787/api.openai.com/v1
export OPENAI_API_KEY=unused     # the proxy strips this and injects the real one
```

```python
# Python, any SDK that takes a base_url
client = OpenAI(base_url="http://127.0.0.1:8787/api.openai.com/v1", api_key="unused")
```

Leave the client's API-key field blank or set it to a dummy value. The proxy
strips client-supplied auth headers before injecting the real one, so a dummy
cannot leak through and cannot override your key.

### Which scheme the proxy uses upstream

Reverse mode has to decide whether `/<domain>/<path>` means `https://<domain>`
or `http://<domain>`. It is decided per host, most specific rule first:

1. **The key's own scheme**, recorded with `skeletonkey add <alias> --scheme http`
   (or `register_key(..., scheme: "http")`). Use it only for a vendor that really
   is plain HTTP — your key goes into that request.
2. **The global `--upstream-scheme http|https`** flag, when you pass one. It
   forces the scheme for every host, and exists so older setups keep working.
3. **`http` for a loopback host** — `localhost`, `127.0.0.0/8`, `::1`. Nothing
   leaves the machine, and a local test server speaking HTTPS is the rare case.
4. **`https` otherwise.**

So a local echo server on `127.0.0.1:9000` works with no flags at all, while
`api.vendor.com` is still reached over TLS. `skeletonkey list` shows the scheme
per key, with a `*` when it was decided per host rather than recorded on the key.

### Disabled keys are refused locally

`skeletonkey disable <alias>` (or the `disable` MCP tool) does not merely stop
injection. The proxy answers calls to that key's domain itself:

```json
HTTP/1.1 403 Forbidden
{
  "error": "key_disabled",
  "alias": "voyage-personal",
  "domain": "api.voyageai.com",
  "hint": "The key voyage-personal for api.voyageai.com is disabled, so SkeletonKey did not inject it and did not forward this request. A human can re-enable it with `skeletonkey enable voyage-personal`."
}
```

Nothing is sent upstream, so nothing can be charged and the caller's own
credential cannot leak to the vendor in place of yours. The refusal is recorded
in the ledger with status `403`, and the agent is told to ask a human for
`skeletonkey enable <alias>` rather than work around it.

### Forward-proxy mode — plain HTTP upstreams only

```bash
HTTP_PROXY=http://127.0.0.1:8787 curl http://api.internal.example/v1/ping
```

### Why `HTTPS_PROXY` does not work — stated plainly

**An HTTPS request through a forward proxy cannot have a header injected into
it, and this tool will not pretend otherwise.**

When a client is configured with `HTTPS_PROXY`, it sends `CONNECT
api.example.com:443` and then negotiates TLS **end to end with the upstream**.
The proxy only shuttles encrypted bytes; it cannot see or modify the HTTP
headers inside, because that is the entire point of TLS. The only way around it
is a MITM proxy: generate a CA, install it in every client's trust store, and
decrypt and re-encrypt all traffic. That is a large, sharp-edged thing to ask of
a personal tool, so this MVP does not do it.

So `skeletonkey proxy` answers `CONNECT` with `405 Method Not Allowed` rather than
tunnelling traffic through with no credential and looking broken.

**Use reverse / base-URL mode for HTTPS APIs.** `HTTP_PROXY` is supported and
works, but only for upstreams you reach over plain HTTP.

### For Codex and Claude Code specifically

Both agents call APIs through whatever your task code or MCP tools use, so the
rule is the same: **set a base URL, not a proxy env var.**

- **If your task code uses an SDK** (OpenAI, Anthropic, Voyage, …), set its
  `base_url` / `OPENAI_BASE_URL`-style option to
  `http://127.0.0.1:8787/<api-domain>/<prefix>` and give it a dummy key.
- **If your task code uses `curl` or `fetch`**, rewrite the URL:
  `https://api.example.com/v1/x` → `http://127.0.0.1:8787/api.example.com/v1/x`.
- **Do not** set `HTTPS_PROXY` in the agent's environment expecting injection to
  happen. It will not, for the reason above. Setting `HTTP_PROXY` is harmless but
  only affects plain-HTTP calls.
- The agent itself should ask SkeletonKey first — see
  [Use with Codex / Claude Code](#use-with-codex--claude-code). The
  `request_access` tool hands back the exact URL to use, so the agent does not
  have to guess.

## Use with Codex / Claude Code

`skeletonkey mcp` is a stdio MCP server. None of its tools can return a secret value
— there is deliberately no such tool — so it is safe to give an agent. Claude Code
and Codex are the **only** supported agents (D8).

### Let `init` do it (recommended)

```bash
skeletonkey init          # or, later: skeletonkey register
```

`init` detects nothing and guesses nothing: it writes four things, after printing
a diff and asking (pass `--yes` to skip the question, `--no-register` to skip the
step entirely):

| File | What goes in it |
| --- | --- |
| `~/.claude.json` | `mcpServers.skeletonkey` — the same entry `claude mcp add -s user` writes. Your other settings and servers are left untouched. |
| `~/.claude/skills/skeletonkey/SKILL.md` | The skill, so the agent knows the workflow and not just the tool list. |
| `~/.codex/config.toml` | `[mcp_servers.skeletonkey]`, inside a `# skeletonkey:begin/end` block so a re-run replaces exactly what SkeletonKey wrote. An entry you wrote yourself always wins. |
| `~/.codex/AGENTS.md` + `~/.codex/skills/skeletonkey/SKILL.md` | The same rules for Codex, behind a managed marker block. |

Re-running is safe and reports `unchanged`. `skeletonkey register --dry-run`
shows what it would do without writing. **Restart the agent afterwards** — and if
the server still does not appear, that is the first row of the
[troubleshooting table](#install-troubleshooting).

### Claude Code, by hand

```bash
claude mcp add skeletonkey -- skeletonkey mcp
# after the npm release:
claude mcp add skeletonkey -s user -- npx -y skeletonkey mcp
```

Then drop the skill in so the agent knows the workflow, not just the tools:

```bash
mkdir -p ~/.claude/skills/skeletonkey
cp skills/skeletonkey/SKILL.md ~/.claude/skills/skeletonkey/SKILL.md
# or per-project: cp -r skills/skeletonkey .claude/skills/skeletonkey
```

### Codex, by hand

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.skeletonkey]
command = "skeletonkey"
args = ["mcp"]
```

If `skeletonkey` is not on your `PATH`, use the absolute path to the built CLI:

```toml
[mcp_servers.skeletonkey]
command = "node"
args = ["/absolute/path/to/skeletonkey/dist/cli.js", "mcp"]
```

`skills/skeletonkey/SKILL.md` doubles as an `AGENTS.md` snippet for Codex — paste
its body into your `AGENTS.md`, or point to it from there.

### The tools

| Tool | Returns |
| --- | --- |
| `find_api(capability, limit?, max_age_days?)` | Matching index entries from `apis.yaml`, your local discovered rows, **and** the generated provider shards in `data/apis/*.yaml`, **best match first**: the verified `billing` model, which aggregators resell it and at what per-call price, a `{route, reason}` recommendation, how it authenticates, a `freshness` block, and whether you already hold a key. Unknown prices are `null`. Also reports `search_terms` / `ignored_terms`, so a query that matched nothing shows *why*. |
| `list_keys()` | Every key's alias, platform, domain, injected header name, header *template*, created/last-used, disabled state. |
| `key_status(alias)` | The above for one key, plus call count, bytes, and recorded spend from the ledger. |
| `access_status(request_id)` | The status of one request: `pending_approval`, `approved`, `ready`, `needs_human` (with a reason such as `no_playbook` or `captcha`), `denied`, `cancelled`, `voided`. After an approved aggregator route it also carries `routed_via`, `routed_cost_usd`, `routed_http_status` and `routed_result` (the aggregator's answer). Opaque ids, statuses and that answer only — no key, no card, no OTP, no screenshot, no page text. |
| `cancel_request(request_id, reason?)` | Cancels a request the agent raised, and closes any Secure Input Popup waiting on it. Agents may cancel; only a human approves. |
| `spend_policy()` | The global monthly cap, the per-vendor caps, and an explicit statement of what an agent may not do (enable a key, raise a cap). Read-only. |
| `request_access(platform, reason, est_budget, max_age_days?)` | Either `has_key: true` with the proxy URL to use, or an `access_request: {request_id, status}` the human decides out of band, plus the signup plan whose final step is **human confirms** — plus the `routing` decision, the billing facts behind it, and a `staleness_warning` when the row it answered from has aged out. If the key exists but is **disabled**, it says so and points at `skeletonkey enable <alias>`. |
| `discover_api(capability)` | The research recipe for a vendor the index has never heard of: which sources to read in which order (vendor docs → pricing page → OpenAPI spec → APIs.guru → signup pages → aggregator catalogs), which field each one fills, and the rules. Reaches no network itself. |
| `propose_entry(...)` | Writes a discovered vendor into the **local** user index with `status: unverified`. Rejects a row with no source URL, a price with no `price_verified_url`, a collision with a reviewed `apis.yaml` row, or any field that looks like a credential. |
| `register_key(alias, platform, domain, header?, format?, scheme?)` | Asks the human for the key **out of band** (a hidden prompt on `/dev/tty`), or returns the exact `skeletonkey add` command for them to run. The agent never sees the secret. `scheme` records a per-key upstream scheme; the header and format default to what the index records for that domain. |
| `ledger(alias?)` | Recent calls and a spend summary. `cost_usd: null` means unknown, not zero. |
| `disable(alias)` | Stops injection **and** makes the proxy refuse calls to that domain locally with `403 {"error": "key_disabled"}`. The secret stays in the vault; only a human can re-enable it. |

The skill file tells the agent the surrounding rules: check SkeletonKey before
hitting any API; if there is no key, use **its own** computer-use/browser tool
and **its own** email connector to sign up and read verification codes; stop for
the human at payment and the final terms confirmation; then call `register_key`;
never paste keys into chat or files.

## Multi-device setup with Tailscale (gateway mode)

> Also known as: multi-device setup over a private network. Gateway mode is the
> only reason to bind anything other than loopback.

One always-on machine holds the keys and runs the proxy. Your laptop, desktop,
and phone call that machine instead of each holding a copy of every key. Revoke
once, and every device loses access.

**What Tailscale is, in two lines:** it builds a private WireGuard network (a
"tailnet") between just your own devices, each with a stable address, so they
can reach each other directly without opening a port to the internet. Traffic is
encrypted device-to-device and nothing is exposed publicly.

### 1. Install Tailscale on the host and on each device

```bash
# macOS/Linux host
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4          # the address SkeletonKey will bind to
```

### 2. Run the gateway on the always-on host

```bash
# Generate a shared token once and keep it in the config file.
openssl rand -hex 32     # paste the result as gateway.token
```

`~/.skeletonkey/config.yaml`:

```yaml
email: apis@example.com
backend: bitwarden
proxy:
  bind: 127.0.0.1
  port: 8787
gateway:
  bind: tailscale          # resolved at startup via `tailscale ip -4`
  port: 8787
  token: <the hex string you just generated>
  # fallback_bind: 100.x.y.z   # used if tailscaled is not up
```

```bash
skeletonkey proxy --gateway
# skeletonkey proxy listening on http://100.101.102.103:8787 (gateway mode)
#   bind:           100.101.102.103 (resolved from `tailscale ip -4`)
#   auth:           X-SkeletonKey-Token required on every request (except /__skeletonkey/health)
```

Flags override the config file: `skeletonkey proxy --gateway --bind tailscale --port 8787`,
or `--bind 100.101.102.103` to skip the lookup, or `--token <value>` /
`SKELETONKEY_GATEWAY_TOKEN` to supply the token out of the file.

### 3. Point other devices at it

Use the tailnet hostname (MagicDNS) or the `100.x` address:

```bash
curl -H "X-SkeletonKey-Token: $SKELETONKEY_GATEWAY_TOKEN" \
  http://my-always-on-host.my-tailnet.ts.net:8787/api.openai.com/v1/models
```

```bash
# For an SDK base URL, the token has to go in the client's default headers.
export OPENAI_BASE_URL=http://my-always-on-host.my-tailnet.ts.net:8787/api.openai.com/v1
```

`GET /__skeletonkey/health` stays unauthenticated so a device can wait for the
gateway to come up; it returns nothing but `{"ok":true,...}`.

### Bind safety rules

These are enforced in code, by a pure function with its own unit tests
(`src/bind.ts`, `test/bind.test.ts`):

| Requested bind | Result |
| --- | --- |
| nothing | `127.0.0.1` |
| `tailscale` | this host's `tailscale ip -4` address; falls back to `gateway.fallback_bind` with a warning; **errors** if neither resolves |
| a specific address (`100.x.y.z`, `192.168.x.y`) | allowed, with a warning that it is not loopback |
| `0.0.0.0`, `::`, `*` | **refused** unless `--allow-all-interfaces` is passed; then allowed with a loud warning |
| `--gateway` with no token | **refused** unless `--insecure-no-token` is passed |

The reason `0.0.0.0` is refused rather than warned about: the proxy spends real
money, and `0.0.0.0` on a laptop means "every coffee-shop network you ever join".

### Optional: restrict the tailnet with an ACL

Tailscale ACLs are deny-by-default once you write them. This snippet lets only
your own user and your own tagged devices reach the gateway port, and nothing
else on the tailnet:

```jsonc
// Tailscale admin console -> Access Controls
{
  "tagOwners": {
    "tag:skeletonkey-gateway": ["autogroup:admin"],
    "tag:skeletonkey-client":  ["autogroup:admin"]
  },
  "acls": [
    {
      // Your own devices (user-based): reach the gateway port only.
      "action": "accept",
      "src":    ["your-login@example.com"],
      "dst":    ["tag:skeletonkey-gateway:8787"]
    },
    {
      // Tagged client devices (e.g. a headless box), same single port.
      "action": "accept",
      "src":    ["tag:skeletonkey-client"],
      "dst":    ["tag:skeletonkey-gateway:8787"]
    }
  ],
  "ssh": []
}
```

Tag the host with `tag:skeletonkey-gateway` (`sudo tailscale up --advertise-tags=tag:skeletonkey-gateway`)
and any headless clients with `tag:skeletonkey-client`. Replace
`your-login@example.com` with your tailnet login. With no other `accept` rules,
nothing else on the tailnet can reach the port — and nothing outside the tailnet
can reach it at all.

**Gateway mode is still a credential.** The token is a bearer secret in a
header, over plain HTTP inside the tailnet (Tailscale encrypts the transport).
Anyone holding the token can spend through every key on the host. Rotate it by
editing the config and restarting.

## Commands

| Command | What it does |
| --- | --- |
| `skeletonkey init` | Creates `SKELETONKEY_HOME`, records the dedicated email and vault backend, then registers the MCP server + skill with Claude Code and Codex (shows a diff first). `--email`, `--backend`, `--op-vault`, `--bw-folder`, `--force`, `--no-register`, `--yes`, `--user-home <dir>`, `--agent-command <cmd>`. Defaults to `bitwarden`. |
| `skeletonkey register` | Registers (or re-registers) the MCP server and skill for Claude Code and Codex. `--dry-run`, `--agent claude-code\|codex`, `--user-home`, `--agent-command`. **This is the fix when the server does not show up in an agent.** |
| `skeletonkey bitwarden status` (alias `skeletonkey bw status`) | Is `bw` installed, logged in and unlocked — and as the bound email? Prints the commands to run when the answer is no, and exits non-zero. `--json`. |
| `skeletonkey bitwarden find <domain>` | Vault items for the **bound email** that match a vendor domain: names, ids, which field matched, whether there is a password or an API key. **Never prints a value.** `--json`. |
| `skeletonkey runner` | Runs the trusted runner: approvals, spend policy, Secure Input Popup, and every secret. `--port` (default 8788, loopback only), `--no-notify`. Also installed as the `skeletonkey-runner` binary. |
| `skeletonkey policy show` / `policy set` | Reads or sets the spend caps. `set --global <usd>`, `--vendor <name> --vendor-cap <usd>`. Human-only: no agent path reaches it. |
| `skeletonkey requests` | Lists the approval requests agents have raised, and where to decide the pending ones. `--json`. |
| `skeletonkey resume` | Clears the kill switch. Human-only; keys disabled by `--all` stay disabled until you `enable` them. |
| `skeletonkey add <alias>` | Stores a secret in the vault and its metadata in `keys.yaml`. `--platform`, `--domain` (required), `--header`, `--format`, `--scheme http\|https` (per-key upstream scheme), `--stdin`. |
| `skeletonkey list` | Shows all keys, their domains, upstream scheme, state, and last use. `--json`. |
| `skeletonkey idle --days N` | Keys with no recorded use in N days (never-used keys always appear). `--json`. |
| `skeletonkey disable <alias>` / `enable <alias>` | Toggles injection. The secret stays in the vault. |
| `skeletonkey disable --all` | **Kill switch.** Disables every key, voids pending approvals, closes any Secure Input Popup, and makes the proxy answer `403 {"error":"kill_switch"}` locally. Cleared by `skeletonkey resume`. |
| `skeletonkey proxy` | Runs the injecting proxy. `--port`, `--bind` (or `--host`), `--gateway`, `--token`, `--allow-all-interfaces`, `--insecure-no-token`, `--upstream-scheme http\|https` (forces the scheme for every host; by default it is decided per host). |
| `skeletonkey mcp` | Runs the stdio MCP server for agents. No tool can return a secret, and every response is passed through the redactor. |
| `skeletonkey ledger` | Prints recent calls. `--limit`, `--json`. |
| `skeletonkey apis validate [file]` | Validates `apis.yaml` (or any index file, including `discovered.yaml`) against the documented schema. |
| `skeletonkey stale-check` | Re-fetches every `billing.verified_url` / `price_verified_url` in the index, fingerprints each page's visible text, and flags **changed**, **unreachable**, and verified-too-long-ago rows. `--max-age-days` (default 90), `--only <name>`, `--no-fetch` (dates only), `--json`. Exits non-zero when a page moved or stopped answering. |

Environment:

| Variable | Effect |
| --- | --- |
| `SKELETONKEY_HOME` | Relocates all state — config, metadata, vaults, ledger. Default `~/.skeletonkey`. The tests and the demo use it to work in temp directories. |
| `KEYRING_HOME` | Deprecated fallback for `SKELETONKEY_HOME`, from before the tool was called SkeletonKey. Used only when `SKELETONKEY_HOME` is unset. |
| `SKELETONKEY_PASSPHRASE` | Passphrase for the `encrypted-file` backend. Prompts if unset and a terminal is available. |
| `SKELETONKEY_GATEWAY_TOKEN` | Shared gateway token, instead of putting it in `config.yaml`. |
| `SKELETONKEY_APIS` | Path to an `apis.yaml` to use instead of the packaged one (a copy in `SKELETONKEY_HOME` is also picked up automatically). |
| `SKELETONKEY_API_SHARDS` | Directories of generated provider shards to merge into the index, separated by the platform path separator. `none` searches `apis.yaml` only. Default: `$SKELETONKEY_HOME/apis.d` if present, then the packaged `data/apis`. |
| `SKELETONKEY_DISCOVERED` | Path to the local user index that `propose_entry` writes and `find_api` reads. Default `$SKELETONKEY_HOME/discovered.yaml`. |
| `SKELETONKEY_STALE_DAYS` | How old a verified fact may be before `find_api`, `request_access` and `stale-check` warn about it. Default `90`. A `max_age_days` argument on the tool, or `--max-age-days` on `stale-check`, wins over it. |
| `SKELETONKEY_USER_HOME` | Home directory agent registration writes under (`~/.claude.json`, `~/.codex/`). Defaults to your real home; the test suite points it at a temp directory so it can never touch yours. |
| `SKELETONKEY_ALLOW_TEST_BACKEND` | Permits the plaintext `file` backend. Only the test suite and `scripts/demo.sh` should set this. |
| `BW_SESSION` | Bitwarden session, from `bw unlock --raw`. Required by the `bitwarden` backend. |

### The ledger

One SQLite row per proxied call, in `$SKELETONKEY_HOME/ledger.db`:

| Column | Meaning |
| --- | --- |
| `alias` | Key used, or `NULL` when no key matched the destination |
| `domain` | Destination hostname |
| `timestamp` | ISO 8601, UTC |
| `status` | Upstream HTTP status, or `NULL` if the call never completed |
| `bytes` | Response body bytes |
| `cost` | `NULL` unless the upstream reported a price in `x-skeletonkey-cost-usd`, `x-cost-usd`, or `x-request-cost-usd` |

v0.3 also writes one row when the runner hands a signup back to a human (§5.4 of
the PRD asks for the event to be logged): the vendor's domain, `status` and
`cost` both `NULL`, `bytes` 0. It is a record that a handoff happened, not a
call that was made — the reason lives in the runner log and in the request's
history.

`cost` is deliberately `NULL` by default. Almost no API reports per-call cost in
a response header, and a made-up number is worse than no number. The MCP
`ledger` and `key_status` tools say "unknown", never "zero". Mapping usage to
money is a roadmap item, not something this MVP guesses at.

`last_used` is the newer of the `keys.yaml` field and the ledger's newest row
for that alias, so `skeletonkey idle` keeps working even if one of the two is reset.

## `apis.yaml`

A hand-maintained index of APIs and how they are paid for: `name`, `url`,
`access_mode` (`intermediary` | `own-account` | `byok`), `min_topup`,
`billing_unit`, `signup_automatable`, `tos_notes`, `source`, `checked_date`, plus
optional `capabilities` (the tags `find_api` matches), `domain`, the auth fields
below, and the `billing` / `aggregators` blocks that drive routing. The full
schema is documented in comments at the top of the file and enforced by
`skeletonkey apis validate`.

### How `find_api` matches a capability

Matching is **whole-word**, scored, and ranked — never substring. A substring
matcher is worse than useless here: `"zzz-vendor-not-in-any-index"` used to
return 41 providers, because `any` is inside `comp**any**`, and `"CVE lookup"`
returned car auctions and phone-number tools, because the word `lookup` turns up
in half the descriptions in the index.

What happens to a query:

1. **It is split into words and lightly stemmed**, on both sides, so `scrape`
   finds `scraping` and `tweets` finds `tweet`.
2. **Generic words are dropped** — `api`, `data`, `search`, `lookup`, `platform`,
   `free`, `the`, `for`, `any`, … The response lists them as `ignored_terms`. A
   query made of nothing *but* generic words (`"any data api"`) returns **no
   matches** and says why, rather than returning a third of the index.
3. **What is left is scored by where it matched**: the vendor's name or API
   domain is strong evidence (3), a short capability tag is good evidence (2), a
   word inside a prose description is weak evidence (1), and matching the whole
   query as an exact tag adds a bonus.
4. **A row is returned** only if it matched at least half the query's words, or
   matched the vendor's own name or domain. Results come back **best score
   first**; ties keep index order, so the hand-written `apis.yaml` row still
   arrives ahead of the generated shard row for the same vendor.

Each match carries its own `match_score` and `matched_terms`. A genuine miss
returns `match_count: 0` — which is the signal to call `discover_api`, not to
invent a vendor.

The merged index (`apis.yaml` + every shard + your discovered rows) is **parsed
once and cached**, keyed by the file list plus each file's mtime and size, so
repeated tool calls in one agent turn do not re-parse ~180 rows of YAML. Editing
any of those files — including `propose_entry` writing a new row — is picked up
on the very next call.

### Auth fields

Each row can also record **how the vendor authenticates**, so an agent never has
to guess: `auth_header` (`Authorization`, `x-api-key`, …), `auth_format` (a
template containing `{key}`, e.g. `Bearer {key}` or `{key}`), `base_url`,
`signup_url` (where signup starts — usually not the docs root in `url`),
`key_page_url`, and the signup gates `email_only_signup`, `requires_card`,
`requires_phone`, `requires_work_email`, plus `human_steps` for anything only a
person can do.

`request_access` returns these, together with ready-made `register_key`
arguments and an explicit `human_gates` list, and `register_key` defaults its
header and format to what the index records for that domain instead of always
`Authorization: Bearer {key}`. That default was wrong for every vendor that uses
`x-api-key`, and a wrong header fails as a vendor `401` indistinguishable from a
bad key. A `null` auth field means **nobody checked** — it never means "none
needed", and the tools say so in their output.

### Billing and routing

Each row can record **how the vendor charges**, and who resells it:

```yaml
billing:
  model: free_tier+payg          # payg | subscription | free_tier+payg
                                 # | free_tier+subscription | free | null
  free_tier_note: >-             # what the free tier IS, in the vendor's numbers
    the first 200 million tokens ... are free for every account
  free_tier_covers_api: true     # true | false | null -- does it cover the API?
  verified_url: https://docs.voyageai.com/docs/pricing
  verified_date: "2026-10-24"
aggregators:
  - name: glasser                # monid | glasser | flatkey
    carries: true
    per_call_price: 0.001        # lowest flat per-call price, USD, or null
    price_verified_url: https://api.glasser.ai/public/catalog
    price_note: >-
      26 endpoints priced per run from $0.001; 57 priced per result ...
```

The validator refuses the shapes that let an unverified claim pass for a
verified one: a `verified_date` without a `verified_url` (or the reverse), a
free-tier model that does not say what the free tier is, a `per_call_price`
with no `price_verified_url`, and a price on a catalog whose `carries` is
`false`. `model: null` means nobody checked — it never means free, and
`per_call_price: null` means that catalog publishes no comparable per-call
price, not that the call is free.

`find_api` and `request_access` turn the two blocks into a **`{route, reason}`**:

| `route` | When |
| --- | --- |
| `direct` | The vendor is pay-as-you-go, is free outright, or its free tier verifiably covers the API (`free_tier_covers_api: true`). Also whenever a key is already in the vault. |
| `aggregator:<name>` | Direct access needs a **monthly subscription**, and this catalog resells the vendor per call at a verified price. Cheapest verified price wins; a tie breaks by catalog order and the reason says so. |
| `unknown` | No billing model is recorded. |

The reason always carries the evidence (which page, read on which date), and
contains the literal words **`price unverified`** whenever no verified price
backs the route. Every route the router did not pick is listed in
`alternatives`, so the subscription it skipped and any dearer carrier it passed
over stay visible. The route is a recommendation about money only: it never overrides a
human gate, and an `aggregator:` route still means somebody has to hold an
account with that aggregator.

#### Taking the aggregator route: the second approval

A route is a recommendation until a human says yes twice. The first approval is
about signing up with the vendor directly; when that ends in a handoff (v0.3
ships no signup playbooks), the runner raises a **second** approval naming the
cheapest carrier and its verified per-call price. Nothing is routed without it.

On that second yes the runner actually makes the call:

- it re-reads the vendor's index row and takes the **cheapest aggregator that
  publishes a verified per-call price and that you hold a key for**. An
  aggregator with no comparable price is not routable — the caps cannot be
  checked against a number nobody has;
- the **caps are re-checked immediately before the call**, against a freshly
  read `policy.yaml` and ledger, exactly as a payment submit is. Over a cap,
  nothing is called;
- the aggregator's key is resolved **exactly like any other key**: found in
  `keys.yaml` by domain, read out of your vault by the runner, injected into the
  aggregator's documented header. No MCP verb returns it, no log line carries
  it, and the agent never sees it;
- the call's cost lands in the ledger (what the aggregator reported, else the
  verified per-call price), and the agent gets `routed_via`, `routed_cost_usd`,
  `routed_http_status` and `routed_result` — the answer, never the credential.

**No aggregator key, no route.** The request ends `needs_human` with the
aggregator's own signup URL and the one `skeletonkey add` command that puts the
key in the vault — fiat, your own card, no crypto rail. Nothing is called, and
no credential is ever guessed. The endpoints themselves are a fixed catalog in
code (`src/aggregators.ts`): an agent names no host on this path. Routes require
current carriage and verified pricing in the API index; approval metadata alone
cannot supply either. Redirects are refused, and responses are redacted before
truncation. The HTTP adapters, authentication, and billing behavior have been
tested against local fakes only; compatibility with live aggregator services
has not been verified.

Carriage for a row that does not state its own is **inherited** from the
generated shards: the shards record `seen_in: [glasser, monid]` per provider, so
a hand-written row that displaced a shard row keeps what the catalogs knew
(carriage only — the shards publish no prices, so `per_call_price` stays `null`).

### Keeping verified prices honest: `stale-check`

A `verified_url` is a promise that somebody read a number off that page on a
date. Pages change silently, which is how an index starts lying.

```bash
skeletonkey stale-check                 # re-fetch everything, compare, exit 1 if anything moved
skeletonkey stale-check --no-fetch      # dates only, no network
skeletonkey stale-check --only apollo --json
```

Each URL is fetched **once** however many rows cite it, and fingerprinted over
its *visible text* — scripts, styles, tags and machine-generated timestamps
stripped — so a rotated token or a rebuilt page does not cry wolf while a price
change still does. Findings are `ok`, `new` (first fingerprint), `changed`,
`unreachable`, `old` (verified outside `--max-age-days`), or `undated`.
`changed` and `unreachable` exit non-zero; `old` is a warning, because the facts
may still be right. Fingerprints live in `$SKELETONKEY_HOME/stale-check.json`.
The fetcher identifies itself with a descriptive `User-Agent` — some vendors
(`nvd.nist.gov`, `www.abuseipdb.com`) answer `403` to an anonymous client.

### Staleness warnings in the tools

`stale-check` is the thing you run; the warning is what an agent sees without
running anything. Every `find_api` match carries a `freshness` block, and
`request_access` adds a `staleness_warning` for the row it is about to
recommend:

```json
"freshness": {
  "checked_date": "2025-02-01",
  "checked_age_days": 631,
  "billing_verified_date": "2025-02-01",
  "billing_age_days": 631,
  "max_age_days": 90,
  "stale": true,
  "warnings": [
    "checked_date is 2025-02-01, 631 days ago -- older than the 90-day window. Re-verify the row (`skeletonkey stale-check`) before trusting its facts.",
    "billing.verified_date is 2025-02-01, 631 days ago -- older than the 90-day window. ..."
  ]
}
```

A row is flagged when `checked_date` or `billing.verified_date` is older than
the window (default **90** days; set `SKELETONKEY_STALE_DAYS`, or pass
`max_age_days` to either tool), **or** when the date is missing altogether on a
row that presents itself as real. Rows that are honest about what they are do
not nag: an `example: true` placeholder and a discovered row still marked
`status: unverified` are exempt, because they already say so in their own field.

### Discover-on-miss

When `find_api` misses, an agent must not invent a vendor, a header, or a price.
`discover_api(capability)` returns the research recipe instead — vendor docs for
the exact auth header, the vendor's pricing page for the billing model, an
OpenAPI/Swagger spec if one exists, [APIs.guru](https://api.apis.guru/v2/list.json),
the signup and key pages, and the aggregator catalogs for carriage — with the
field each source fills and the rules that apply. The agent does the research
with its own tools, then calls `propose_entry`.

Proposed rows go to a **local user index** (`$SKELETONKEY_HOME/discovered.yaml`,
or `SKELETONKEY_DISCOVERED`), never into the packaged `apis.yaml`, and they are
written `status: unverified` whatever the caller passes. **An agent cannot
verify its own research.** A row becomes `status: verified` only when a call to
its domain through the proxy returns `2xx`; the next `find_api` or
`request_access` promotes it and records the ledger row that earned it in
`promoted_by`:

```yaml
status: verified
promoted_date: 2026-10-25
promoted_by: "ledger: 200 from services.nvd.nist.gov at 2026-10-25T00:32:38.284Z"
```

`propose_entry` also refuses a row with no `source_urls`, a price with no URL
behind it, a name or domain already covered by a reviewed `apis.yaml` row, and
any field that looks like a credential — record the header *name* and the
template (`Bearer {key}`), never a value.

[`data/discovered.example.yaml`](data/discovered.example.yaml) holds two real
discoveries made this way (the NVD CVE API and AbuseIPDB); copy it to
`$SKELETONKEY_HOME/discovered.yaml` to start from them. Both ship `unverified`:
the proof belongs to the home that made the call.

### The generated shards

`find_api` and `request_access` search `apis.yaml` **merged with** the generated
provider index in [`data/apis/*.yaml`](data/apis/README.md) (163 providers across
26 category shards, machine-built from three aggregator catalogs). `apis.yaml`
wins: a shard row is dropped when a row in `apis.yaml` has the same name or the
same registrable domain, so the hand-written row — the one that knows the auth
header — is what an agent sees. Shard rows carry no auth facts and no API domain,
because the shards record `auth_type: api_key` (which does not say *which*
header) and the vendor's homepage (which is not the API host); each row is tagged
`index_origin: shard` so the difference is visible. Point
`SKELETONKEY_API_SHARDS` somewhere else, or set it to `none`, to change that.

Two rules, enforced by tests:

- **Unknown prices are `null`.** Never a guess, never "about $5". A row with `checked_date: null` has been checked by nobody, so it may not claim a `min_topup` at all.
- **A verified row ships its evidence.** A `checked_date` means a human (or a generated catalog read) looked at the source on that day, so the row must name that `source` URL — and any `min_topup` it does claim must come with the `billing_unit` that makes the number mean something. Verified rows *are* allowed here; what is not allowed is a number with nothing behind it.

Both rules are enforced across the whole merged index, not just `apis.yaml`.

The entries shipped in this repo are all marked `example: true`, including the
three that back the scenarios in
[docs/v0.1-acceptance.md](docs/v0.1-acceptance.md) (`example-x-twitter-api`,
`example-apify-scraping`, `example-voyage-embeddings`). They exist to show the
shape of the file and to give `find_api` something to match. **They are not real
offers and contain no verified prices.**

## Roadmap

Phases, following the PRD:

- **v0.3 (this release) — zero-knowledge foundation.** Trusted runner, async approvals, the secret resolution ladder with the Secure Input Popup, the domain allowlist, `policy.yaml`, the kill switch across proxy and runner, redaction everywhere, `init` auto-registration for Claude Code and Codex, and guided Bitwarden account detection with vendor lookup by the bound email. See [What v0.3 adds](#what-v03-adds).
- **v0.5 — automated signup.** Publish to npm (drop `"private": true`) so `npx skeletonkey init` works; bind an inbox and extract OTPs; a Playwright runner with playbooks for Apify, TikHub, Apollo and DropLeads, preferring OAuth or a passkey over a password; key capture straight into `bw`; a computer-use guided handoff for captcha and phone checks, logged, with the aggregator fallback offered only on approval.
- **v1.0 — payments and the budget wallet.** Card autofill from Bitwarden, pre-approval and top-up rules, receipt parsing into the ledger (the per-vendor cap re-check before submit already landed in v0.3), and a `automation: allowed|human|unknown` ToS matrix in `apis.yaml`. Fiat only; one card, no virtual cards.
- **Hosted (post-v1, gated).** Not scheduled, and nothing decided: a hosted MCP, an optional cloud runner, and anything resembling a prepaid balance all wait on legal review.

Smaller things, unscheduled:

- **Assisted signup, further along.** Filling in `signup_automatable` from verified terms, and a dry-run mode that shows exactly what is about to be agreed to and paid. A human presses the last button. Always.
- **Weekly discovery scan.** `skeletonkey stale-check` already re-reads every verified price page and flags what moved, and `discover_api`/`propose_entry` already add vendors the index was missing. Next: running both on a schedule, and filling in `source` and `checked_date` from a human review step. Still `null` for anything it cannot verify.
- **Rotation and expiry.** `skeletonkey rotate <alias>` against providers with a key-management API, plus warnings on keys older than a chosen age.
- **Per-key budgets.** Decline at the proxy when an alias passes a spend or call-count ceiling, instead of finding out from a bill.
- **Per-call cost attribution.** Real numbers in the ledger's mostly-`NULL` `cost` column, from receipts and usage endpoints rather than a guess.
- **Smaller things.** `skeletonkey remove <alias>` (vault plus metadata), ledger export to CSV, request-scoped tokens so one agent run cannot reuse the proxy later, and a native Secure Input window instead of a localhost page (D10).

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # builds, then runs vitest
./scripts/demo.sh    # end-to-end, localhost only
```

The suite runs against the `encrypted-file` and `file` backends in temp
directories and covers:

- `keys.yaml` never contains a secret, and file modes are `0600`;
- the encrypted vault round-trips, uses a fresh salt and nonce per write, rejects a wrong passphrase, detects tampering, and **leaves no plaintext secret on disk**;
- the plaintext `file` backend is refused without the opt-in env var;
- the proxy injects the configured header in both modes, strips client-supplied auth headers, skips disabled and non-matching keys, writes no secret to any log, and records one ledger row per call;
- gateway mode rejects a missing or wrong `X-SkeletonKey-Token` (including a prefix of the right one) and never forwards the token upstream;
- the bind-safety rules — loopback default, Tailscale resolution and fallback, refusal of `0.0.0.0`/`::`, token required in gateway mode;
- **every MCP tool handler, called in-process with a stored fake secret, asserting that no response contains it**;
- the `apis.yaml` validator accepts the shipped file and rejects malformed entries including guessed prices, and the capability matcher finds the right entries without matching junk.

v0.3 adds:

- **the canary sweep** (`test/canary.test.ts`): a fake API key, password, card number and CVV are pushed through the real paths — the vault, the `bw` rung of the ladder, the Secure Input Popup — and then *every* tool response (including with hostile arguments), every runner page and API response, the runner log, every file under `SKELETONKEY_HOME` read as raw bytes, and all CLI output are swept for them; plus a second test proving no tool, argument, or runner route lets an agent enable a key or raise a cap;
- **the Bitwarden account lookup** (`test/bw-account.test.ts`, `test/bw-cli.test.ts`): every state of `bw` (missing, logged out, locked, unlocked, logged in as the wrong account) through both a fake runner and a **fake `bw` script on PATH** — asserting that the guidance names the install steps, `bw login <bound email>` and `BW_SESSION`, that nothing ever asks for or passes a master password, that `init` refuses to finish while `bw` is unusable, and that a vendor item belonging to a *different* mailbox never answers for that vendor;
- **the ladder** with fakes for every rung: it stops at Bitwarden, falls through a locked or missing `bw` without trying to unlock it, refuses a lookalike or plain-HTTP origin before asking any rung, redacts a rung that throws, and never logs a value;
- **the runner**: token-authed agent API with no secret-returning verb, the approval page (approve, deny, stale form token, caps written with the human's authority recorded), cancellation, the aggregator-fallback approval after a failed signup and the
  execution of that route against a **fake aggregator HTTP server** (cheapest
  *configured* carrier wins, the key comes out of the vault and appears in no
  response, log or file, `needs_human` with a signup URL when no key is
  configured, and the caps re-checked immediately before the call) (D14), the kill switch voiding pending approvals, loopback-only human pages, and a masked Secure Input Popup whose response never echoes the value;
- **the spend policy**: $0 defaults, the first-paid-action prompt, unknown cost never auto-approved, and cap writes refused without a human authority;
- **the redactor**: cards by Luhn, prefixed keys, labelled secrets, and `null` left alone because "nobody checked" is load-bearing here;
- **agent registration**: both agents, idempotent, preserving your own settings, refusing a `~/.claude.json` it cannot parse and a Codex entry you wrote yourself — all into a temp home, so the suite never touches your real one;
- **the kill switch end to end**: through the built CLI and a live proxy, including that `resume` does not re-enable keys.

Node 22's `node:sqlite` is used for the ledger, so there is no native
dependency to compile. It is still flagged experimental in Node 22, and the CLI
suppresses that one warning.

## License

MIT — see [LICENSE](LICENSE).
