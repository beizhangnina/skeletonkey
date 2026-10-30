/**
 * Bitwarden account detection and vendor lookup by the bound email (§A).
 *
 * Everything here runs against a fake `bw`: the suite never talks to a real
 * vault. Three properties are asserted over and over, because they are the
 * point of the feature:
 *
 *   - the state is read, never worked around: a locked or logged-out `bw`
 *     produces *instructions for the human*, not an attempt to unlock;
 *   - no master password is ever asked for, read, or passed to `bw`;
 *   - an item belonging to a different mailbox never answers for the vendor.
 */
import { describe, expect, it } from "vitest";
import {
  BW_INSTALL_URL,
  bwAccountStatus,
  bwGuidance,
  bwGuidanceError,
  describeVendorItems,
  findVendorItems,
  parseBwStatus,
  sameMailbox,
  searchTerms,
  type BwRunner,
} from "../src/vault/bw-account.js";
import { BitwardenSecretSource } from "../src/secrets/bitwarden.js";
import type { SecretRequest } from "../src/secrets/types.js";

const BOUND = "apis@example.test";
const VENDOR_PASSWORD = "FAKE-vendor-password-0xA1";
const VENDOR_KEY = "sk-test-FAKE-tikhub-0xA2";
const APOLLO_KEY = "sk-test-FAKE-apollo-0xA3";
const OTHER_PASSWORD = "FAKE-other-mailbox-0xA4";

/** The vault a human filled in themselves, long before SkeletonKey existed. */
const ITEMS: Record<string, unknown>[] = [
  {
    id: "item-tikhub",
    name: "TikHub",
    login: {
      username: BOUND,
      password: VENDOR_PASSWORD,
      uris: [{ uri: "https://tikhub.io/login" }],
    },
    fields: [{ name: "API key", value: VENDOR_KEY, type: 1 }],
  },
  {
    // Same vendor, someone else's account. Must never answer.
    id: "item-tikhub-other",
    name: "TikHub (work account)",
    login: {
      username: "someone.else@corp.test",
      password: OTHER_PASSWORD,
      uris: [{ uri: "https://tikhub.io/login" }],
    },
  },
  {
    id: "item-apify",
    name: "Apify",
    login: {
      username: "apis+apify@example.test",
      password: "FAKE-apify-password-0xA5",
      uris: [{ uri: "https://console.apify.com/sign-in" }],
    },
  },
  {
    id: "item-apollo",
    name: "Apollo.io",
    login: { uris: [{ uri: "https://app.apollo.io" }] },
    fields: [
      { name: "Email", value: BOUND, type: 0 },
      { name: "X-Api-Key", value: APOLLO_KEY, type: 1 },
    ],
  },
  {
    id: "item-voyage",
    name: "Voyage AI",
    login: {
      password: "FAKE-voyage-password-0xA6",
      uris: [{ uri: "https://api.voyageai.com" }, { uri: `mailto:${BOUND}` }],
    },
  },
  {
    id: "item-dropleads",
    name: "DropLeads",
    notes: `signed up with ${BOUND} in March`,
    login: { password: "FAKE-dropleads-password-0xA7", uris: [{ uri: "https://dropleads.io" }] },
  },
];

interface Fake {
  runner: BwRunner;
  calls: string[][];
}

/**
 * A `bw` that answers from the fixture. `--search` is deliberately loose, the
 * way the real CLI is -- which is exactly why the filtering lives in our code.
 */
function fakeBw(
  options: {
    state?: "unlocked" | "locked" | "unauthenticated";
    userEmail?: string | null;
    items?: Record<string, unknown>[];
    /** Simulate `bw` not being on PATH at all. */
    missing?: boolean;
  } = {},
): Fake {
  const calls: string[][] = [];
  const items = options.items ?? ITEMS;
  const runner: BwRunner = async (args) => {
    calls.push(args);
    if (options.missing === true) throw new Error("`bw` was not found on PATH.");
    if (args[0] === "status") {
      return {
        code: 0,
        stdout: JSON.stringify({
          serverUrl: null,
          userEmail: options.userEmail ?? null,
          status: options.state ?? "unlocked",
        }),
        stderr: "",
      };
    }
    if (args[0] === "list" && args[1] === "items") {
      const term = (args[3] ?? "").toLowerCase();
      const matched = items.filter((item) => searchable(item).includes(term));
      return { code: 0, stdout: JSON.stringify(matched), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { runner, calls };
}

/** Name, URIs, username and notes: roughly what `bw --search` looks at. */
function searchable(item: Record<string, unknown>): string {
  const login = (item["login"] ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(login["uris"]) ? (login["uris"] as { uri?: string }[]) : [];
  return [
    String(item["name"] ?? ""),
    String(item["notes"] ?? ""),
    String(login["username"] ?? ""),
    ...uris.map((entry) => entry.uri ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

function request(overrides: Partial<SecretRequest> = {}): SecretRequest {
  return {
    class: "api_key",
    vendor: "TikHub",
    origin: "https://tikhub.io/dashboard",
    field: "API key",
    ...overrides,
  };
}

describe("bw status detection", () => {
  it("reads the state and the account out of `bw status`", async () => {
    const { runner, calls } = fakeBw({ state: "unlocked", userEmail: BOUND });
    const status = await bwAccountStatus({ bound: BOUND, bw: runner });
    expect(status).toMatchObject({
      state: "unlocked",
      usable: true,
      account: BOUND,
      bound: BOUND,
      matchesBound: true,
    });
    expect(status.summary).toMatch(/installed, logged in and unlocked/);
    expect(calls).toEqual([["status"]]);
  });

  it("reports locked, logged-out and missing without trying to fix any of them", async () => {
    for (const [options, state] of [
      [{ state: "locked" as const }, "locked"],
      [{ state: "unauthenticated" as const }, "unauthenticated"],
      [{ missing: true }, "not-installed"],
    ] as const) {
      const { runner, calls } = fakeBw(options);
      const status = await bwAccountStatus({ bound: BOUND, bw: runner });
      expect(status.state).toBe(state);
      expect(status.usable).toBe(false);
      // One call, and it is a read. Never `unlock`, never `login`.
      expect(calls).toEqual([["status"]]);
    }
  });

  it("treats `command not found` on stderr as not installed", async () => {
    const runner: BwRunner = async () => ({ code: 127, stdout: "", stderr: "sh: bw: not found" });
    expect((await bwAccountStatus({ bound: BOUND, bw: runner })).state).toBe("not-installed");
  });

  it("falls back to `unknown` for an answer it cannot read", async () => {
    const runner: BwRunner = async () => ({ code: 0, stdout: "???", stderr: "" });
    const status = await bwAccountStatus({ bound: BOUND, bw: runner });
    expect(status.state).toBe("unknown");
    expect(status.usable).toBe(false);
  });

  it("still parses the bare-word status older builds printed", () => {
    expect(parseBwStatus('"unlocked"')).toEqual({ status: "unlocked", userEmail: null });
    expect(parseBwStatus('{"status":"locked","userEmail":"a@b.test"}')).toEqual({
      status: "locked",
      userEmail: "a@b.test",
    });
  });

  it("notices when `bw` is logged in as some other account", async () => {
    const { runner } = fakeBw({ userEmail: "personal@example.test" });
    const status = await bwAccountStatus({ bound: BOUND, bw: runner });
    expect(status.matchesBound).toBe(false);
    expect(status.summary).toContain("NOT the bound email");
  });

  it("counts a +alias as the same mailbox", () => {
    expect(sameMailbox("apis+tikhub@example.test", BOUND)).toBe(true);
    expect(sameMailbox("APIS@EXAMPLE.TEST", BOUND)).toBe(true);
    expect(sameMailbox("apis@other.test", BOUND)).toBe(false);
    expect(sameMailbox(null, BOUND)).toBe(false);
  });
});

describe("the guided prompt", () => {
  const promise = /never asks for, stores, or passes on your Bitwarden master password/;

  it("gives install steps, the login line and the unlock line when nothing is installed", async () => {
    const { runner } = fakeBw({ missing: true });
    const lines = bwGuidance(await bwAccountStatus({ bound: BOUND, bw: runner })).join("\n");
    expect(lines).toContain("npm install -g @bitwarden/cli");
    expect(lines).toContain(BW_INSTALL_URL);
    expect(lines).toContain(`bw login ${BOUND}`);
    expect(lines).toContain('export BW_SESSION="$(bw unlock --raw)"');
    expect(lines).toMatch(promise);
  });

  it("asks only for the session when `bw` is merely locked", async () => {
    const { runner } = fakeBw({ state: "locked" });
    const lines = bwGuidance(await bwAccountStatus({ bound: BOUND, bw: runner })).join("\n");
    expect(lines).toContain('export BW_SESSION="$(bw unlock --raw)"');
    expect(lines).not.toContain("bw login");
    expect(lines).toMatch(promise);
  });

  it("uses the address the human confirmed, not the configured one", async () => {
    const { runner } = fakeBw({ state: "unauthenticated" });
    const status = await bwAccountStatus({ bound: BOUND, bw: runner });
    expect(bwGuidance(status, "confirmed@example.test").join("\n")).toContain(
      "bw login confirmed@example.test",
    );
    // And with nothing to go on it says so rather than inventing an address.
    const blank = await bwAccountStatus({ bound: null, bw: runner });
    expect(bwGuidance(blank).join("\n")).toContain("bw login <your bound email>");
  });

  it("never asks the human to hand over a master password", async () => {
    for (const options of [
      { missing: true },
      { state: "locked" as const },
      { state: "unauthenticated" as const },
    ]) {
      const { runner } = fakeBw(options);
      const lines = bwGuidance(await bwAccountStatus({ bound: BOUND, bw: runner })).join("\n");
      // No prompt, no flag, no pipe: the password is never ours to handle.
      expect(lines).not.toMatch(/--passwordenv|--password |enter your master password|type your master/i);
      expect(lines).toMatch(/run (these|SkeletonKey)|in your own terminal/i);
    }
  });

  it("says nothing at all when `bw` is unlocked as the bound account", async () => {
    const { runner } = fakeBw({ userEmail: BOUND });
    expect(bwGuidance(await bwAccountStatus({ bound: BOUND, bw: runner }))).toEqual([]);
  });

  it("flags an account mismatch even when unlocked", async () => {
    const { runner } = fakeBw({ userEmail: "personal@example.test" });
    const lines = bwGuidance(await bwAccountStatus({ bound: BOUND, bw: runner })).join("\n");
    expect(lines).toContain("bw logout");
    expect(lines).toContain(BOUND);
  });

  it("packs the whole prompt into one error for a hard failure", async () => {
    const { runner } = fakeBw({ state: "locked" });
    const error = bwGuidanceError(await bwAccountStatus({ bound: BOUND, bw: runner }));
    expect(error.message).toMatch(/^Bitwarden is not ready: .*locked/);
    expect(error.message).toContain("BW_SESSION");
  });
});

describe("finding a vendor account by bound email + domain", () => {
  it("searches the domain and its base domain", () => {
    expect(searchTerms("api.tikhub.io")).toEqual(["api.tikhub.io", "tikhub.io"]);
    expect(searchTerms("tikhub.io")).toEqual(["tikhub.io"]);
  });

  it("finds the item whose login username is the bound email", async () => {
    const { runner, calls } = fakeBw();
    const lookup = await findVendorItems({ domain: "api.tikhub.io", bound: BOUND, bw: runner });
    expect(lookup.items.map((item) => item.id)).toEqual(["item-tikhub"]);
    expect(lookup.items[0]).toMatchObject({
      email_match: "username",
      domain_match: "uri",
      has_password: true,
      api_key_field: "API key",
      api_key: VENDOR_KEY,
      password: VENDOR_PASSWORD,
    });
    expect(lookup.detail).toContain("1 Bitwarden item(s)");
    // Only reads, and the searches are domains -- never a secret in argv.
    expect(calls).toEqual([
      ["status"],
      ["list", "items", "--search", "api.tikhub.io"],
      ["list", "items", "--search", "tikhub.io"],
    ]);
  });

  it("never returns the same vendor's item for a different mailbox", async () => {
    const { runner } = fakeBw();
    const lookup = await findVendorItems({ domain: "tikhub.io", bound: BOUND, bw: runner });
    expect(lookup.items.map((item) => item.id)).not.toContain("item-tikhub-other");
    expect(JSON.stringify(lookup.items)).not.toContain(OTHER_PASSWORD);
  });

  it("matches a +alias username, a custom field, a mailto URI and a notes line", async () => {
    const { runner } = fakeBw();
    const cases: [string, string, string][] = [
      ["console.apify.com", "item-apify", "username"],
      ["app.apollo.io", "item-apollo", "field"],
      ["api.voyageai.com", "item-voyage", "uri"],
      ["dropleads.io", "item-dropleads", "notes"],
    ];
    for (const [domain, id, match] of cases) {
      const lookup = await findVendorItems({ domain, bound: BOUND, bw: runner });
      expect(lookup.items.map((item) => item.id), domain).toContain(id);
      expect(lookup.items.find((item) => item.id === id)?.email_match, domain).toBe(match);
    }
  });

  it("picks up an API key out of a custom field, whatever it is called", async () => {
    const { runner } = fakeBw();
    const lookup = await findVendorItems({ domain: "app.apollo.io", bound: BOUND, bw: runner });
    expect(lookup.items[0]).toMatchObject({ api_key_field: "X-Api-Key", api_key: APOLLO_KEY });
    expect(lookup.items[0]?.has_password).toBe(false);
  });

  it("does not look anything up when `bw` is locked, and says why", async () => {
    const { runner, calls } = fakeBw({ state: "locked" });
    const lookup = await findVendorItems({ domain: "tikhub.io", bound: BOUND, bw: runner });
    expect(lookup.items).toEqual([]);
    expect(lookup.detail).toMatch(/cannot be read right now.*locked/);
    expect(calls).toEqual([["status"]]);
  });

  it("refuses to guess when no email is bound", async () => {
    const { runner, calls } = fakeBw();
    const lookup = await findVendorItems({ domain: "tikhub.io", bound: null, bw: runner });
    expect(lookup.items).toEqual([]);
    expect(lookup.detail).toMatch(/No bound email/);
    expect(calls).toEqual([["status"]]);
  });

  it("ignores an item for the bound email that has nothing to do with the vendor", async () => {
    // `bw --search` is loose, so this is the item it hands back for any term.
    const { runner } = fakeBw({
      items: [
        {
          id: "item-unrelated",
          name: "Electricity bill",
          login: { username: BOUND, password: "FAKE-unrelated-0xA9" },
        },
      ],
    });
    const lookup = await findVendorItems({ domain: "tikhub.io", bound: BOUND, bw: runner });
    expect(lookup.items).toEqual([]);
  });

  it("reports an empty result as an empty result", async () => {
    const { runner } = fakeBw();
    const lookup = await findVendorItems({ domain: "nothing.example", bound: BOUND, bw: runner });
    expect(lookup.items).toEqual([]);
    expect(lookup.detail).toMatch(/No Bitwarden item for apis@example\.test/);
  });

  it("describes items without printing a single value", async () => {
    const { runner } = fakeBw();
    const lookup = await findVendorItems({ domain: "api.tikhub.io", bound: BOUND, bw: runner });
    const described = describeVendorItems(lookup).join("\n");
    expect(described).toContain("TikHub (item-tikhub)");
    expect(described).toContain('API key in field "API key"');
    for (const value of [VENDOR_KEY, VENDOR_PASSWORD, APOLLO_KEY, OTHER_PASSWORD]) {
      expect(described).not.toContain(value);
    }
  });
});

describe("the Bitwarden rung, reading the human's own vendor account", () => {
  it("answers an api_key from the vendor's item when SkeletonKey has no item of its own", async () => {
    const { runner } = fakeBw();
    const source = new BitwardenSecretSource(runner, { boundEmail: BOUND });
    const resolved = await source.resolve(request());
    expect(resolved?.value).toBe(VENDOR_KEY);
    expect(resolved?.detail).toContain("matched by the bound email");
    expect(resolved?.detail).not.toContain(VENDOR_KEY);
  });

  it("prefers the item SkeletonKey wrote itself", async () => {
    const { runner } = fakeBw({
      items: [
        ...ITEMS,
        {
          id: "item-managed",
          name: "skeletonkey: tikhub",
          login: { username: BOUND, password: "sk-test-FAKE-managed-0xA8" },
        },
      ],
    });
    const source = new BitwardenSecretSource(runner, { boundEmail: BOUND });
    const resolved = await source.resolve(request({ class: "password", alias: "tikhub" }));
    expect(resolved?.value).toBe("sk-test-FAKE-managed-0xA8");
    expect(resolved?.detail).toContain('login item "skeletonkey: tikhub"');
  });

  it("answers a password from the vendor's own item", async () => {
    const { runner } = fakeBw();
    const source = new BitwardenSecretSource(runner, { boundEmail: BOUND });
    const resolved = await source.resolve(
      request({ class: "password", field: "password", origin: "https://tikhub.io/login" }),
    );
    expect(resolved?.value).toBe(VENDOR_PASSWORD);
  });

  it("takes the domain from the request when it is given, not only from the origin", async () => {
    const { runner } = fakeBw();
    const source = new BitwardenSecretSource(runner, { boundEmail: BOUND });
    const resolved = await source.resolve(
      request({ vendor: "Apollo", origin: "https://app.apollo.io/#/settings", domain: "app.apollo.io" }),
    );
    expect(resolved?.value).toBe(APOLLO_KEY);
  });

  it("will not read another mailbox's item for the vendor", async () => {
    const { runner } = fakeBw({ items: [ITEMS[1] as Record<string, unknown>] });
    const source = new BitwardenSecretSource(runner, { boundEmail: BOUND });
    const resolved = await source.resolve(request({ class: "password" }));
    expect(resolved).toBeNull();
    expect(source.lastDetail()).toMatch(/no Bitwarden item for apis@example\.test matches tikhub\.io/);
  });

  it("says nothing can be matched when no email is bound", async () => {
    const { runner } = fakeBw();
    const source = new BitwardenSecretSource(runner);
    expect(await source.resolve(request())).toBeNull();
    expect(source.lastDetail()).toMatch(/no bound email is configured/);
  });

  it("hands the human the steps exactly once, on first secret use", async () => {
    const { runner } = fakeBw({ state: "locked" });
    const given: string[][] = [];
    const source = new BitwardenSecretSource(runner, {
      boundEmail: BOUND,
      onGuidance: (lines) => given.push(lines),
    });
    expect(await source.resolve(request())).toBeNull();
    expect(await source.resolve(request({ class: "password" }))).toBeNull();
    expect(given).toHaveLength(1);
    expect(given[0]?.join("\n")).toContain('export BW_SESSION="$(bw unlock --raw)"');
    expect(source.lastDetail()).toMatch(/locked.*human action/i);
  });

  it("reports the state the ladder already expected", async () => {
    for (const [options, state] of [
      [{ state: "locked" as const }, "locked"],
      [{ state: "unauthenticated" as const }, "unauthenticated"],
      [{ missing: true }, "unavailable"],
    ] as const) {
      const { runner } = fakeBw(options);
      expect(await new BitwardenSecretSource(runner).state()).toBe(state);
    }
  });
});
