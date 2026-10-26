# The `skeletonkey init` wizard

Shipped in **0.3.0**. At a terminal, `skeletonkey init` is a six-step wizard
that ticks each step off as it completes. With `--yes`, or whenever stdin is not
a TTY, it is the old flags-only setup instead — unchanged, and still what CI
runs.

**Only step 1 — your email — is required.** Every other step can be deferred,
nothing in the wizard refuses to finish because a step was skipped, and the
closing summary splits what is set up from what is deferred, printing under each
deferred line the exact command that finishes it later.

```
$ skeletonkey init
SkeletonKey init -- 6 steps. Ctrl-C quits; nothing is written yet.
Only step 1 (your email) is required. Anything else can be deferred, and the
summary ends with the exact command that finishes each deferred item.

Step 1/6  Email
  This is the one answer `init` cannot do without; every step after it can be
  deferred, and the summary will tell you how to finish each one later.
  Recommended: a brand-new address used only for API signups, e.g.
    apis@yourdomain.com  (or a free mailbox you make just for this)
  ...
  Dedicated email for API signups: apis@example.com
  ✔ bound email apis@example.com

Step 2/6  Bitwarden (recommended, skippable)
  Where should secrets live?
    1) bitwarden       `bw` CLI -- free, unlimited devices, syncs (default)
    ...
  Backend [1/2/3/4 or name] (1):
  Bitwarden: the `bw` CLI is logged in but locked.
    export BW_SESSION="$(bw unlock --raw)"
    ...
  Only your email is required, so this step has three ways on:
    1) set Bitwarden up now -- run the lines above, then I re-check (recommended)
    2) use the encrypted-file vault instead -- AES-256-GCM under SKELETONKEY_HOME, nothing to install
    3) skip for now -- `init` finishes, and the summary says how to come back
  Press Enter once you have run those and I will re-check, or [2] encrypted-file instead / [3] skip for now: 3
  — Bitwarden not ready. `init` finishes anyway; ... `skeletonkey bitwarden status` re-checks any time.
...
Summary
  Set up
    ✔ email       apis@example.com
    ✔ vault       bitwarden -- Bitwarden vault (items named "skeletonkey: <alias>")
    ✔ agents      registered with Claude Code and Codex (4 file(s) written)

  Deferred -- not required now; under each line is the command that finishes it
    ! bitwarden   the `bw` CLI is logged in but locked
        skeletonkey bitwarden status
    — spend caps  every cap is still $0, so nothing can be spent
        skeletonkey policy set --global <usd>
    — card        not checked -- create "skeletonkey: card" in Bitwarden when you want payments
        skeletonkey init --force

  Coming soon: inbox connect (v0.5) -- nothing to run yet

Next:
  skeletonkey runner      # approvals, spend caps, secure input, secrets
  skeletonkey proxy       # the injecting proxy your calls go through
  skeletonkey policy show # the caps, any time
  Restart Claude Code / Codex so they pick the MCP server up.
```

## What is required, and what is deferred

| Step | Required? | Skipping it means | Finish it later with |
| --- | --- | --- | --- |
| 1. Email | **Yes** | Nothing to file vendor accounts under, so a run that never produces a usable address fails instead of writing half a config. | — |
| 2. Bitwarden | No (recommended) | Either the `encrypted-file` vault instead, or no vault CLI yet: `skeletonkey add` and the proxy refuse with the unlock steps until `bw` is ready. | `skeletonkey bitwarden status` |
| 3. Inbox connect | Not available | Nothing: it ships in v0.5. The runner asks you for an OTP in its Secure Input Popup until then. | — (v0.5) |
| 4. Spend caps | No | Every cap stays at **$0**, so nothing can be spent and the first paid action raises an approval asking you to set them. | `skeletonkey policy set --global <usd>` |
| 5. Card | No | v0.3 pays for nothing anyway. Create the item when you want payments. | `skeletonkey init --force` (v0.3 has no `card` verb; the wizard's own re-run is the check) |
| 6. Agents | No | Claude Code and Codex do not see the MCP server yet. | `skeletonkey register` |

Those commands are not prose: they live in `FINISH_COMMANDS` in
`src/init-wizard.ts`, and `test/init-wizard.test.ts` resolves every one of them
against the real `buildProgram()` command tree, so renaming a verb fails the
suite rather than leaving the summary pointing at a command that no longer
exists.

## Where `init` still refuses

Exactly one path refuses to finish when Bitwarden is unusable, and it is the
**explicit non-interactive** one:

```bash
skeletonkey init --email apis@example.com --backend bitwarden --yes   # bw locked -> exit 1
```

There is no human to put the choice to, and `--backend bitwarden` was asked for
by name, so finishing would mean writing a `config.yaml` that names a vault
which cannot be opened. It exits non-zero, writes **nothing**, and prints both
ways past itself first:

```
Bitwarden is not required; either of these finishes setup instead.
  The zero-install vault (AES-256-GCM file under SKELETONKEY_HOME):
    skeletonkey init --email apis@example.com --backend encrypted-file --yes
  Or at a terminal, where the wizard offers Bitwarden / encrypted-file / later and finishes either way:
    skeletonkey init
```

The wizard is the opposite: step 2 offers the three-way choice and finishes
whichever one you take. `test/bw-cli.test.ts` pins the refusal and then walks
one of the two ways out; `test/init-wizard.test.ts` pins that the wizard never
aborts.

## When the wizard runs

| Condition | What happens |
| --- | --- |
| stdin is a TTY and `--yes` was not passed | The wizard. |
| `--yes` | The flags-only path. `--email` and `--backend` required when there is also no TTY. |
| stdin is not a TTY (CI, a pipe, a script) | The flags-only path, with or without `--yes`. |

Anything already given on the command line is treated as answered and is not
asked again:

```bash
skeletonkey init --email apis@example.com --backend bitwarden   # steps 1-2 answered
skeletonkey init --no-register                                  # step 6 announced, skipped
skeletonkey init --email apis@example.com --backend encrypted-file --yes
```

## The steps

### 1. Email (the one required step)

The **bound email**: the address every vendor account, password reset and
billing notice is filed under, and the one `skeletonkey bitwarden find` and the
Bitwarden rung of the secret ladder match vendor items on. A brand-new address
used only for API signups is recommended out loud, because mixing this with a
personal inbox is the thing people regret. `+aliases`
(`apis+tikhub@yourdomain.com`) then tell you who leaked the address.

A malformed address is re-asked, not accepted, and a run that never produces a
usable address fails rather than writing a config with nothing to bind accounts
to. This is the only step that can end a run.

### 2. Bitwarden (recommended, skippable)

Picks the backend (Bitwarden unless `--backend` says otherwise), then walks from
wherever `bw` is to unlocked:

- **`bw` not on PATH** → the install commands are printed
  (`npm install -g @bitwarden/cli`, `brew install bitwarden-cli`,
  `snap install bw`, or the binary from <https://bitwarden.com/help/cli/>).
- **No Bitwarden account** → "Do you already have a Bitwarden account? [Y/n]".
  Answer `n` and <https://vault.bitwarden.com/#/register> is opened
  best-effort and **always printed**. You sign up yourself.
- **Not logged in / locked** → `bw login <bound email>` and
  `export BW_SESSION="$(bw unlock --raw)"` are printed for you to run **in your
  own terminal**. Press Enter and `bw status` is re-read; the step ticks when it
  says `unlocked`.
- **Logged in as a different account** → said plainly, with both addresses, and
  the two ways to fix it.

**Recommended, not required.** Whenever `bw` is not ready, the same prompt
offers three ways on, and two of them finish `init` immediately:

| Answer | What happens |
| --- | --- |
| Enter (or `1`) | "I ran those lines" — `bw status` is re-read and the step ticks when it says `unlocked`. The recommended path, and the one Enter takes. |
| `2` (or `encrypted-file`) | The vault becomes **`encrypted-file`**: AES-256-GCM under `SKELETONKEY_HOME`, nothing to install. If `--backend bitwarden` was on the command line, the wizard says plainly that your answer just overrode it. Bitwarden can be set up later with `skeletonkey bitwarden status`. |
| `3` (or `skip`) | The backend stays Bitwarden and the step is deferred. `init` finishes; `skeletonkey add` and the proxy refuse with these same steps until `bw` is ready. |

Five unparseable backend choices keep the Bitwarden default and proceed to its
skippable setup. Five unparseable setup answers are taken as "skip for now" rather than aborting a run
that only ever needed an email address. Twenty re-checks without `bw` becoming
usable do the same.

> **The master password is never requested.** `bw login` and `bw unlock` are
> commands *you* run; the only thing that crosses back into SkeletonKey is the
> `BW_SESSION` you export. The wizard's `ask()` helper refuses outright to put
> any question containing "password", "passphrase", "CVV", "card number", "API
> key" or "secret" to a human, and a test asserts it.

Choosing another backend (`1password`, `keychain`, `encrypted-file`) skips the
Bitwarden CLI entirely; that backend's own check runs instead, which is where
`encrypted-file` asks for its passphrase.

### 3. Inbox connect

Binding a mailbox so the runner can read a vendor's verification code itself —
filtered to that vendor's sender domain and a short time window — lands in
**v0.5**. The interface and the filters already exist (`src/secrets/inbox.ts`).
The step says so and skips. Until then the runner asks you for the code in its
Secure Input Popup, and no agent is ever asked to read your mail in its place.

### 4. Spend caps (skippable)

Asks for a global monthly cap and then any number of per-vendor caps.

- A blank answer keeps the **$0** default — no number is ever preset (D11), and
  the first paid action raises an approval asking you to set them.
- `skip` skips the step without writing anything: **every cap stays at $0**, so
  skipping cannot leave money spendable. `policy.yaml` is not even created, and
  the read-back default is $0 globally and per vendor.
- Anything that is not a number of dollars is re-asked.
- Deferred, the summary prints `skeletonkey policy set --global <usd>`.

Caps are written through `setCaps(..., { by: "cli" })` in `src/policy.ts` — the
**same human-only writer** `skeletonkey policy set` and the approval page use.
The wizard adds no second write path, and `policy.yaml` records
`last_change_by: cli`. An agent can never reach any of it.

### 5. Card (skippable)

v0.3 pays for nothing. When payments land it is **one** card item in your own
Bitwarden vault (D12: no virtual cards), read by the runner in memory and typed
into the vendor's own checkout, after you approve the amount against your caps.

So this step explains how to create that item **in Bitwarden's own app or web
vault** — New item → type `Card` → named exactly:

```
skeletonkey: card
```

— and then checks only that an item with that name exists. The number, the CVV
and the expiry are **never read, printed, logged or returned**: the check
(`cardItemPresent`) looks at item names and returns a boolean, nothing else.

Answer `n` and the step is skipped; the check is also skipped, without failing,
when Bitwarden is not readable. Deferred, the summary prints
`skeletonkey init --force` — v0.3 has no `card` verb, so re-running the wizard
*is* the re-check, and the summary says what to create first.

### 6. Register with Claude Code / Codex

The existing registration logic (D8: those two agents only), which prints a diff
before writing and reports `unchanged` on a re-run. `--no-register` announces the
step as skipped and the summary defers it with `skeletonkey register`; declining
the diff does the same.

### The summary

Two sections. **Set up** lists what this run settled; **Deferred** lists what it
did not, each line followed by the exact command that finishes it (see
[the table above](#what-is-required-and-what-is-deferred)). Bitwarden is left
out of the summary entirely for a backend that never used it — the `vault` line
has already said where secrets live — and inbox connect is listed separately as **Coming soon**, because no command
exists until v0.5. Every item in **Deferred** has a real follow-up command.

## Testing it

Everything the wizard touches outside its own process is a dependency: the
prompt and output (`WizardIo`), the `bw` runner (`BwRunner`), and the browser
opener (`UrlOpener`). `test/init-wizard.test.ts` drives all six steps with a
scripted prompt, a fake `bw`, a fake opener and a temp `SKELETONKEY_HOME`, so
the suite never installs Bitwarden, never opens a browser and never touches a
real vault. It covers each step, each skip path, the `--yes` and non-TTY paths
(asserted to produce *no* wizard output), that no password is ever prompted or
passed to `bw`, and that a stored card number never appears in any output or
return value. One check allocates a real pty with `script(1)` to prove the TTY
branch is the wizard.

It also pins the two properties the skippable steps turn on:

- **nothing but the email can end a run** — each of the three step-2 answers is
  driven through `runInitWizard` to a summary, including the one that switches
  the vault to `encrypted-file` (asserted by what `commit` is handed), and five
  junk answers at that fork are asserted to defer rather than throw;
- **every finish-it-later command exists** — `FINISH_COMMANDS` is resolved
  word by word against the real `buildProgram()` tree, sub-commands by name or
  alias and `--flags` against the options of the command they follow, with two
  deliberately wrong commands asserted to fail the same walker.

`test/bw-cli.test.ts` holds the other side: the explicit non-interactive path
still exits non-zero with `bw` locked, writes nothing, prints both ways out —
and the `--backend encrypted-file` way out is driven end to end against the same
locked fake `bw`.
