# SkeletonKey — the master key for your agents

**Just-in-time API access, so your agents stop hitting walls.** An agent that
needs a paid API shouldn't stall waiting for you to go sign up, make a key, and
paste it somewhere. It asks SkeletonKey, gets access at the moment it needs it,
and calls the API through a proxy that attaches the credential on the way out.

A local-only vault for your own API keys, plus a loopback proxy that injects
them for you and an MCP server your agent can talk to. Your agents and scripts
call the proxy; the proxy holds the keys. Nothing is uploaded anywhere, there is
no account, and there is no server component.

Status: MVP. TypeScript, Node 22+, MIT licensed. Repo:
[`beizhangnina/skeletonkey`](https://github.com/beizhangnina/skeletonkey) (public, MIT).

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

### Not needed in v0.1

- **A credit card.** v0.1 stores and injects keys; it does not pay for anything.
  Payments are phase 2, and the plan there is a **capped virtual card** per key
  (one merchant lock, a low limit, so a forgotten key cannot drain anything).
  Even then the **card stays in your own vault and is never touched by SkeletonKey
  code** — SkeletonKey would hold a reference, not a number. If a provider wants
  money today, you enter your own card on their site, by hand.
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
- **npm publish is intentionally disabled for now.** `package.json` sets `"private": true` so the package cannot be published to npm by accident. Install from source (clone, `npm install`, `npm run build`).
- **Client-supplied auth headers are stripped.** `authorization`, `proxy-authorization`, `x-api-key`, `api-key`, `x-auth-token`, `x-access-token`, `x-skeletonkey-token`, and the key's own header are removed from every request before the vault header is injected. A caller cannot smuggle its own credential through, cannot override yours, and the gateway token never reaches the upstream.
- **The MCP server cannot reveal a key.** There is no such tool, and a test calls every handler with a stored secret and asserts no response contains it. The only tool that touches a secret, `register_key`, does so by prompting the human on `/dev/tty` — out of band from the agent entirely.
- **Nothing is logged that could leak a key.** Log lines carry method, domain, path, status, byte count, and alias. As a backstop, the proxy redacts any secret it has loaded from any line it is about to print.
- **Files are tight by default.** `SKELETONKEY_HOME` is `0700`; `config.yaml`, `keys.yaml`, `vault.enc.json`, `dev-vault.json`, and `ledger.db` are `0600`.
- **`CONNECT` is refused with 405.** A `CONNECT` tunnel is end-to-end TLS, so the proxy cannot inject into it. Rather than pass traffic through with no credential and look broken, it says no. This is why `HTTPS_PROXY` is not supported — see [Calling APIs through the proxy](#calling-apis-through-the-proxy).

What this tool does *not* do:

- It is **not** a secret manager for a team, and has no sharing, rotation, or audit story beyond your own ledger.
- It does **not** protect against malicious code already running as your user. Such code can just call the proxy. The vault backends raise the bar (Bitwarden locks, Keychain and 1Password can require your approval); nothing stops a process that can reach `127.0.0.1:8787`.
- It does **not** encrypt the ledger. The ledger holds domains, timestamps, statuses, and byte counts — no payloads, no secrets — but it is still a record of what you call.
- The `file` backend is **plaintext and test-only**. It is hidden from `skeletonkey init` and refused unless `SKELETONKEY_ALLOW_TEST_BACKEND=1` is set. The test suite and `scripts/demo.sh` are the only things that should ever use it.

### Backends

| Backend | Where secrets go | Needs | Notes |
| --- | --- | --- | --- |
| `bitwarden` **(default)** | Bitwarden login items named `skeletonkey: <alias>` | `bw` CLI, logged in and unlocked | Free tier, unlimited devices, syncs, open source, self-hostable via Vaultwarden. Export `BW_SESSION="$(bw unlock --raw)"` first. |
| `1password` | 1Password API Credential items titled `skeletonkey: <alias>` | `op` CLI, signed in | Optional; for people who already use it. |
| `keychain` | macOS login keychain (`security`), or libsecret (`secret-tool`) on Linux | OS keystore | No account, no sync. On Linux needs `libsecret-tools` and a running Secret Service. |
| `encrypted-file` | `$SKELETONKEY_HOME/vault.enc.json` — AES-256-GCM, key from scrypt over your passphrase | nothing | Zero install. Passphrase from `SKELETONKEY_PASSPHRASE` or a hidden prompt. Lose the passphrase, lose the keys. |
| `file` | `$SKELETONKEY_HOME/dev-vault.json`, mode `0600`, **plaintext** | nothing | **Test-only.** Hidden from `init`, refused without `SKELETONKEY_ALLOW_TEST_BACKEND=1`. |

The `bw`, `op`, `security`, and `secret-tool` backends depend on CLIs that are
not present on the Linux CI used to develop this MVP, so they are exercised by
hand rather than by the automated suite. `encrypted-file` and `file` are fully
covered by tests, including an assertion that the encrypted vault on disk does
not contain the plaintext secret.

## Quickstart

```bash
git clone https://github.com/beizhangnina/skeletonkey.git
cd skeletonkey
npm install
npm run build
npm link            # optional: puts `skeletonkey` (and the short alias `skk`) on your PATH
```

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
skeletonkey disable old-api   # stop injecting, keep the metadata and the secret
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
— there is deliberately no such tool — so it is safe to give an agent.

### Claude Code

```bash
claude mcp add skeletonkey -- skeletonkey mcp
```

Then drop the skill in so the agent knows the workflow, not just the tools:

```bash
mkdir -p ~/.claude/skills/skeletonkey
cp skills/skeletonkey/SKILL.md ~/.claude/skills/skeletonkey/SKILL.md
# or per-project: cp -r skills/skeletonkey .claude/skills/skeletonkey
```

### Codex

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
| `find_api(capability)` | Matching `apis.yaml` entries: how each is paid for, whether signup is automatable, and whether you already hold a key. Unknown prices are `null`. |
| `list_keys()` | Every key's alias, platform, domain, injected header name, header *template*, created/last-used, disabled state. |
| `key_status(alias)` | The above for one key, plus call count, bytes, and recorded spend from the ledger. |
| `request_access(platform, reason, est_budget)` | Either `has_key: true` with the proxy URL to use, or a signup plan whose final step is **human confirms**. |
| `register_key(alias, platform, domain)` | Asks the human for the key **out of band** (a hidden prompt on `/dev/tty`), or returns the exact `skeletonkey add` command for them to run. The agent never sees the secret. |
| `ledger(alias?)` | Recent calls and a spend summary. `cost_usd: null` means unknown, not zero. |
| `disable(alias)` | Stops injection. The secret stays in the vault; only a human can re-enable it. |

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
| `skeletonkey init` | Creates `SKELETONKEY_HOME`, records the dedicated email and vault backend. `--email`, `--backend`, `--op-vault`, `--bw-folder`, `--force`. Defaults to `bitwarden`. |
| `skeletonkey add <alias>` | Stores a secret in the vault and its metadata in `keys.yaml`. `--platform`, `--domain` (required), `--header`, `--format`, `--stdin`. |
| `skeletonkey list` | Shows all keys, their domains, state, and last use. `--json`. |
| `skeletonkey idle --days N` | Keys with no recorded use in N days (never-used keys always appear). `--json`. |
| `skeletonkey disable <alias>` / `enable <alias>` | Toggles injection. The secret stays in the vault. |
| `skeletonkey proxy` | Runs the injecting proxy. `--port`, `--bind` (or `--host`), `--gateway`, `--token`, `--allow-all-interfaces`, `--insecure-no-token`, `--upstream-scheme http\|https`. |
| `skeletonkey mcp` | Runs the stdio MCP server for agents. No tool can return a secret. |
| `skeletonkey ledger` | Prints recent calls. `--limit`, `--json`. |
| `skeletonkey apis validate [file]` | Validates `apis.yaml` against the documented schema. |

Environment:

| Variable | Effect |
| --- | --- |
| `SKELETONKEY_HOME` | Relocates all state — config, metadata, vaults, ledger. Default `~/.skeletonkey`. The tests and the demo use it to work in temp directories. |
| `KEYRING_HOME` | Deprecated fallback for `SKELETONKEY_HOME`, from before the tool was called SkeletonKey. Used only when `SKELETONKEY_HOME` is unset. |
| `SKELETONKEY_PASSPHRASE` | Passphrase for the `encrypted-file` backend. Prompts if unset and a terminal is available. |
| `SKELETONKEY_GATEWAY_TOKEN` | Shared gateway token, instead of putting it in `config.yaml`. |
| `SKELETONKEY_APIS` | Path to an `apis.yaml` to use instead of the packaged one (a copy in `SKELETONKEY_HOME` is also picked up automatically). |
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

`cost` is deliberately `NULL` by default. Almost no API reports per-call cost in
a response header, and a made-up number is worse than no number. The MCP
`ledger` and `key_status` tools say "unknown", never "zero". Mapping usage to
money is a roadmap item, not something this MVP guesses at.

`last_used` is the newer of the `keys.yaml` field and the ledger's newest row
for that alias, so `skeletonkey idle` keeps working even if one of the two is reset.

## `apis.yaml`

A hand-maintained index of APIs and how they are paid for: `name`, `url`,
`access_mode` (`x402` | `intermediary` | `own-account` | `byok`), `min_topup`,
`billing_unit`, `signup_automatable`, `tos_notes`, `source`, `checked_date`, plus
optional `capabilities` (the tags `find_api` matches) and `domain`. The full
schema is documented in comments at the top of the file and enforced by
`skeletonkey apis validate`.

Two rules, enforced by tests:

- **Unknown prices are `null`.** Never a guess, never "about $5". `min_topup: null` means nobody has checked.
- **Unverified rows have `checked_date: null`.** A date means a human looked at the source on that day.

The entries shipped in this repo are all marked `example: true`, including the
three that back the scenarios in
[docs/v0.1-acceptance.md](docs/v0.1-acceptance.md) (`example-x-twitter-api`,
`example-apify-scraping`, `example-voyage-embeddings`). They exist to show the
shape of the file and to give `find_api` something to match. **They are not real
offers and contain no verified prices.**

## Roadmap

- **Payments.** Per-key virtual cards (one merchant lock per key, low limits, so a compromised or forgotten key cannot drain anything) and native [x402](https://x402.org) support, so the proxy can answer a `402` with a payment rather than needing an account at all. The card itself stays in your own vault; SkeletonKey code never handles the number. Includes real cost attribution in the ledger instead of today's mostly-`NULL` column.
- **Assisted signup, further along.** v0.1 produces the plan and stores the result; the agent's own browser and email do the work. Next: filling in `signup_automatable` from verified terms, and a dry-run mode that shows exactly what is about to be agreed to and paid. A human presses the last button. Always.
- **Weekly discovery scan.** A local job that refreshes `apis.yaml` — new APIs, changed prices, changed terms — filling in `source` and `checked_date` and flagging rows that have gone stale. Still `null` for anything it cannot verify.
- **Rotation and expiry.** `skeletonkey rotate <alias>` against providers with a key-management API, plus warnings on keys older than a chosen age.
- **Per-key budgets.** Decline at the proxy when an alias passes a spend or call-count ceiling, instead of finding out from a bill.
- **Smaller things.** `skeletonkey remove <alias>` (vault plus metadata), ledger export to CSV, `x402`-aware retry, request-scoped tokens so one agent run cannot reuse the proxy later.

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

Node 22's `node:sqlite` is used for the ledger, so there is no native
dependency to compile. It is still flagged experimental in Node 22, and the CLI
suppresses that one warning.

## License

MIT — see [LICENSE](LICENSE).
