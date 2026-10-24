---
name: skeletonkey
description: Check SkeletonKey before calling any paid or key-gated API. Use when a task needs an external API (social data, scraping, embeddings, LLMs, geocoding, anything with an API key), when a call returns 401/403/429, or when you are about to ask a human for an API key. Finds whether a key already exists, gets access just-in-time via agent-assisted signup with the human confirming the final step, and routes calls through the local injecting proxy so you never hold the key.
---

# SkeletonKey

SkeletonKey holds this user's API keys. **You never see a key.** You call
APIs through a local proxy that attaches the credential on the way out, and the
proxy writes one ledger row per call so the user can see what you spent.

This file is also usable as an `AGENTS.md` snippet for Codex — the rules below
are the same either way.

## The rule

**Before calling any API that needs a key, ask SkeletonKey first.** Never ask
the user to paste a key into the chat, never read one from an `.env` file, and
never put one in a file, a commit, or an environment variable.

## Tools

SkeletonKey exposes an MCP server (`skeletonkey mcp`). None of its tools can return
a secret value — there is deliberately no such tool.

| Tool | Use it to |
| --- | --- |
| `find_api(capability)` | See which APIs are known for a capability, how they are paid for, and whether a key already exists. |
| `list_keys()` | List every key: alias, platform, domain, state. Metadata only. |
| `key_status(alias)` | One key's state, last use, and recorded spend. |
| `request_access(platform, reason, est_budget)` | Get either a proxy URL to call through, or a signup plan. **Start here.** |
| `register_key(alias, platform, domain)` | After signup: ask the human to enter the key out of band. |
| `ledger(alias?)` | Recent calls and spend, so you can report what a task cost. |
| `disable(alias)` | Stop a key being injected. Use the moment one looks compromised. |

If the MCP server is not available, the same things work from the shell:
`skeletonkey list`, `skeletonkey ledger`, `skeletonkey add <alias> ...` (the human runs
this one), `skeletonkey disable <alias>`.

## Workflow

### 1. Check before you reach

```
find_api("web scraping")        -> what exists, and whether a key is on file
request_access(platform="Apify", reason="scrape 200 product pages", est_budget=5)
```

If `has_key` is true you get a `proxy_url`. Go to step 4.

If the key exists but is `disabled`, **stop and tell the user.** Do not work
around a disabled key — someone disabled it on purpose.

### 2. No key? Sign up yourself, with your own tools

`request_access` returns a plan. The signup is yours to drive, using **your own**
capabilities, not SkeletonKey's:

- Your **computer-use or browser tool** opens the provider's signup page.
- Your **own email connector** reads the verification code and completes
  verification. Use the dedicated SkeletonKey email with a `+alias`
  (`apis+apify@example.com`) so vendor mail stays sorted — `request_access`
  tells you the exact address to use.
- Create the API key in the provider's dashboard. **Do not copy it into your
  context, a file, or the chat.** Leave it on screen.

Before you start: check the `apis.yaml` entry's `tos_notes` and
`signup_automatable`. If `signup_automatable` is not `true`, the terms have not
been cleared for automated signup — say so and ask the user before driving the
browser. A `min_topup` of `null` means **unknown**, not free; never state a
price the entry does not contain.

### 3. Stop for the human — twice

Hand control back, in plain words, at both of these:

- **Payment.** Any card entry, any top-up, any paid plan. The user's card, the
  user's hands. Never yours.
- **The final Terms-of-Service confirmation.** The last button that creates the
  account or commits the spend is pressed by the human, after you have shown
  them what they are agreeing to and what it costs.

Then call `register_key(alias, platform, domain)`. It asks the human to type the
key straight into the vault on their own terminal (or tells them the one
`skeletonkey add` command to run). The secret goes from their screen into the vault
without passing through you. If the tool reports `stored: false`, relay the
command it gives you and wait — do not offer to handle the key yourself.

### 4. Call the API through the proxy

Send the request to the proxy's URL with **no credential of your own**:

```
curl http://127.0.0.1:8787/api.apify.com/v2/acts
```

That is reverse / base-URL mode: the destination domain goes in the path. If the
tool you are using takes a base URL, point it at
`http://127.0.0.1:8787/<api-domain>` and leave its API-key field blank or set to
a dummy value — the proxy strips client-supplied auth headers and injects the
real one.

`HTTPS_PROXY` does **not** work: an HTTPS `CONNECT` tunnel is end-to-end
encrypted, so no header can be injected into it, and the proxy answers `405`
rather than pretend. Use reverse mode for HTTPS APIs. `HTTP_PROXY` works for
plain-HTTP upstreams only.

If a call returns `401`/`403`, do not retry with a key of your own. Call
`key_status(alias)` and report what you find.

### 5. Report the cost

Finish with `ledger(alias)` and tell the user what the task actually used.
`cost_usd: null` means the upstream reported no price — say "unknown", not
"free" and not a guess.

## Never

- Never ask a human to tell you, type into chat, or paste an API key.
- Never write a key to a file, a commit, an environment variable, or your own
  notes. If one ends up in your context anyway, say so immediately and
  recommend `skeletonkey disable <alias>` plus rotation at the provider.
- Never complete a payment or accept terms on the user's behalf.
- Never re-enable a disabled key, or route around the proxy to call an API
  directly with a credential you found somewhere.
- Never state a price that is not in `apis.yaml`. Unknown is `null`.
