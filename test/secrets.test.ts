import { describe, expect, it } from "vitest";
import { Allowlist } from "../src/allowlist.js";
import { Redactor } from "../src/redact.js";
import { BitwardenSecretSource, type BwRunner } from "../src/secrets/bitwarden.js";
import { BoundInboxSource, type InboxMessage, type InboxReader } from "../src/secrets/inbox.js";
import { resolveSecret } from "../src/secrets/ladder.js";
import { PopupRegistry, PopupSecretSource } from "../src/secrets/popup.js";
import {
  isResolved,
  neverViaAgent,
  type SecretRequest,
  type SecretResolution,
  type SecretSource,
} from "../src/secrets/types.js";

const CARD = "4242424242424242";
const CVV = "321";
const PASSWORD = "generated-FAKE-password-canary";
const OTP = "483920";

const ALLOWLIST = new Allowlist([
  { domain: "api.tikhub.io", vendor: "TikHub", source: "api-index" },
  { domain: "tikhub.io", vendor: "TikHub", source: "api-index" },
]);

function request(overrides: Partial<SecretRequest> = {}): SecretRequest {
  return {
    class: "card_number",
    vendor: "TikHub",
    origin: "https://tikhub.io/checkout",
    field: "card number",
    ...overrides,
  };
}

/** A `bw` that answers from a fixture instead of a vault. */
function fakeBw(
  items: Record<string, unknown>[],
  state: "unlocked" | "locked" | "unauthenticated" | "missing" = "unlocked",
): { runner: BwRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: BwRunner = async (args) => {
    calls.push(args);
    if (args[0] === "status") {
      if (state === "missing") return { code: 1, stdout: "", stderr: "bw: not found" };
      return { code: 0, stdout: JSON.stringify({ status: state }), stderr: "" };
    }
    if (args[0] === "list" && args[1] === "items") {
      const search = args[3] ?? "";
      const matched = items.filter((item) => String(item["name"] ?? "").includes(search));
      return { code: 0, stdout: JSON.stringify(matched), stderr: "" };
    }
    if (args[0] === "create") return { code: 0, stdout: "{}", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { runner, calls };
}

class FakeInbox implements InboxReader {
  constructor(
    private readonly address: string | null,
    private readonly messages: InboxMessage[] = [],
  ) {}
  boundAddress(): string | null {
    return this.address;
  }
  async recent(): Promise<InboxMessage[]> {
    return this.messages;
  }
}

/** Records that it was asked, so the ladder's order can be asserted. */
class SpySource implements SecretSource {
  asked = 0;
  constructor(
    readonly id: SecretResolution["source"],
    private readonly answer: string | null,
  ) {}
  handles(): boolean {
    return true;
  }
  lastDetail(): string | null {
    return "spy";
  }
  async resolve(): Promise<SecretResolution | null> {
    this.asked += 1;
    if (this.answer === null) return null;
    return { source: this.id, value: this.answer, detail: `${this.id} answered` };
  }
}

describe("the secret resolution ladder (§5a)", () => {
  it("stops at Bitwarden and never asks the later rungs", async () => {
    const bw = new SpySource("bitwarden", CARD);
    const inbox = new SpySource("inbox", OTP);
    const popup = new SpySource("popup", "typed");
    const result = await resolveSecret(request(), {
      sources: [bw, inbox, popup],
      allowlist: ALLOWLIST,
    });
    expect(isResolved(result.outcome)).toBe(true);
    expect(result.outcome.source).toBe("bitwarden");
    expect(bw.asked).toBe(1);
    expect(inbox.asked).toBe(0);
    expect(popup.asked).toBe(0);
  });

  it("falls through to the inbox, then to the popup, in that order", async () => {
    const bw = new SpySource("bitwarden", null);
    const inbox = new SpySource("inbox", null);
    const popup = new SpySource("popup", "typed-by-human");
    const result = await resolveSecret(request({ class: "otp", field: "SMS code" }), {
      sources: [bw, inbox, popup],
      allowlist: ALLOWLIST,
    });
    expect(result.outcome.source).toBe("popup");
    expect(result.attempts.map((attempt) => attempt.source)).toEqual([
      "bitwarden",
      "inbox",
      "popup",
    ]);
    expect(bw.asked).toBe(1);
    expect(inbox.asked).toBe(1);
  });

  it("blocks a lookalike origin before any rung is asked", async () => {
    const bw = new SpySource("bitwarden", CARD);
    const popup = new SpySource("popup", "typed");
    const result = await resolveSecret(
      request({ origin: "https://tikhub.io.evil.example/checkout" }),
      { sources: [bw, popup], allowlist: ALLOWLIST },
    );
    expect(isResolved(result.outcome)).toBe(false);
    expect(result.outcome).toMatchObject({ source: null, kind: "blocked" });
    expect(bw.asked).toBe(0);
    expect(popup.asked).toBe(0);
  });

  it("blocks a plain-http origin even when the domain is right", async () => {
    const result = await resolveSecret(request({ origin: "http://api.tikhub.io/pay" }), {
      sources: [new SpySource("bitwarden", CARD)],
      allowlist: ALLOWLIST,
    });
    expect(result.outcome).toMatchObject({ kind: "blocked" });
    expect((result.outcome as { detail: string }).detail).toMatch(/not https/);
  });

  it("registers what it resolved with the redactor, and logs no value", async () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    const result = await resolveSecret(request(), {
      sources: [new SpySource("bitwarden", CARD)],
      allowlist: ALLOWLIST,
      redactor,
      log: (line) => lines.push(line),
    });
    expect(isResolved(result.outcome)).toBe(true);
    expect(lines.join("\n")).not.toContain(CARD);
    expect(lines.join("\n")).toMatch(/16 chars, value not logged/);
    // And the value is now unprintable everywhere else too.
    expect(redactor.redact(`paying with ${CARD}`)).not.toContain(CARD);
  });

  it("reports exhaustion rather than asking the agent", async () => {
    const result = await resolveSecret(request(), {
      sources: [new SpySource("bitwarden", null), new SpySource("popup", null)],
      allowlist: ALLOWLIST,
    });
    expect(result.outcome).toMatchObject({ source: null, kind: "unavailable" });
    expect((result.outcome as { detail: string }).detail).toMatch(/agent is\s+not asked/);
  });

  it("treats a throwing rung as a rung that did not answer", async () => {
    const thrower: SecretSource = {
      id: "bitwarden",
      handles: () => true,
      lastDetail: () => null,
      resolve: async () => {
        throw new Error(`bw blew up while holding ${CARD}`);
      },
    };
    const lines: string[] = [];
    const result = await resolveSecret(request(), {
      sources: [thrower, new SpySource("popup", "typed")],
      allowlist: ALLOWLIST,
      log: (line) => lines.push(line),
    });
    expect(result.outcome.source).toBe("popup");
    // Even an exception message is redacted on the way to the log.
    expect(lines.join("\n")).not.toContain(CARD);
  });

  it("names the classes that may never pass through the AI", () => {
    for (const klass of ["api_key", "password", "card_number", "card_cvv"] as const) {
      expect(neverViaAgent(klass)).toBe(true);
    }
    // §5a: an OTP is the one class an agent may ever see.
    expect(neverViaAgent("otp")).toBe(false);
  });
});

describe("BitwardenSecretSource", () => {
  it("reads the card number and the CVV from the card item", async () => {
    const { runner, calls } = fakeBw([
      {
        name: "skeletonkey: card",
        card: { number: CARD, code: CVV, expMonth: "4", expYear: "2031" },
      },
    ]);
    const source = new BitwardenSecretSource(runner);
    const number = await source.resolve(request());
    const cvv = await source.resolve(request({ class: "card_cvv", field: "CVV" }));
    const expiry = await source.resolve(request({ class: "card_expiry", field: "expiry" }));
    expect(number?.value).toBe(CARD);
    expect(cvv?.value).toBe(CVV);
    expect(expiry?.value).toBe("04/2031");
    // Secrets are never in argv: only `status` and `list items --search`.
    expect(calls.every((args) => !args.includes(CARD))).toBe(true);
    expect(number?.detail).not.toContain(CARD);
  });

  it("falls through when the vault is locked, rather than unlocking it", async () => {
    const { runner, calls } = fakeBw([], "locked");
    const source = new BitwardenSecretSource(runner);
    expect(await source.resolve(request())).toBeNull();
    expect(source.lastDetail()).toMatch(/locked.*human action/i);
    // It did not try to read anything, and certainly not to unlock.
    expect(calls).toEqual([["status"]]);
  });

  it("falls through when bw is not installed or not logged in", async () => {
    for (const [state, pattern] of [
      ["missing", /not available/i],
      ["unauthenticated", /not logged in/i],
    ] as const) {
      const { runner } = fakeBw([], state);
      const source = new BitwardenSecretSource(runner);
      expect(await source.resolve(request())).toBeNull();
      expect(source.lastDetail()).toMatch(pattern);
    }
  });

  it("falls through when the card item has no CVV stored", async () => {
    const { runner } = fakeBw([{ name: "skeletonkey: card", card: { number: CARD, code: "" } }]);
    const source = new BitwardenSecretSource(runner);
    expect(await source.resolve(request({ class: "card_cvv", field: "CVV" }))).toBeNull();
    expect(source.lastDetail()).toMatch(/Secure Input Popup/);
  });

  it("reads a generated signup password from a login item, and saves one on stdin", async () => {
    const { runner, calls } = fakeBw([
      { name: "skeletonkey: tikhub", login: { username: "tikhub", password: PASSWORD } },
    ]);
    const source = new BitwardenSecretSource(runner);
    const resolved = await source.resolve(
      request({ class: "password", field: "password", alias: "tikhub" }),
    );
    expect(resolved?.value).toBe(PASSWORD);

    expect(await source.savePassword("apify", PASSWORD)).toBe(true);
    const create = calls.find((args) => args[0] === "create");
    expect(create).toEqual(["create", "item"]);
    expect(JSON.stringify(calls)).not.toContain(PASSWORD);
  });

  it("never claims to answer an email OTP", async () => {
    const { runner } = fakeBw([]);
    const source = new BitwardenSecretSource(runner);
    expect(source.handles("otp")).toBe(false);
    expect(await source.resolve(request({ class: "otp", field: "code" }))).toBeNull();
  });
});

describe("BoundInboxSource", () => {
  it("answers an OTP from a message sent by the vendor domain", async () => {
    const source = new BoundInboxSource(
      new FakeInbox("apis@example.test", [
        {
          from: "noreply@mail.tikhub.io",
          subject: "Your code",
          body: `Your verification code is ${OTP}.`,
          received: new Date().toISOString(),
        },
      ]),
    );
    const resolved = await source.resolve(request({ class: "otp", field: "SMS code" }));
    expect(resolved?.value).toBe(OTP);
    expect(resolved?.detail).not.toContain(OTP);
  });

  it("ignores a message from someone other than the vendor", async () => {
    const source = new BoundInboxSource(
      new FakeInbox("apis@example.test", [
        {
          from: "phish@evil.example",
          subject: "Your code",
          body: `code ${OTP}`,
          received: new Date().toISOString(),
        },
      ]),
    );
    expect(await source.resolve(request({ class: "otp", field: "code" }))).toBeNull();
  });

  it("says plainly that nothing is bound yet, instead of asking the agent", async () => {
    const source = new BoundInboxSource();
    expect(await source.resolve(request({ class: "otp", field: "code" }))).toBeNull();
    expect(source.lastDetail()).toMatch(/No inbox is bound/);
    expect(source.lastDetail()).toMatch(/never asked to read the mailbox/);
  });

  it("handles only OTPs", () => {
    const source = new BoundInboxSource();
    expect(source.handles("otp")).toBe(true);
    for (const klass of ["api_key", "password", "card_number", "card_cvv"] as const) {
      expect(source.handles(klass)).toBe(false);
    }
  });
});

describe("the Secure Input Popup registry", () => {
  it("hands a typed value to the waiter and keeps only its length", async () => {
    const registry = new PopupRegistry();
    const source = new PopupSecretSource({
      registry,
      urlFor: (id) => `http://127.0.0.1:8788/input/${id}`,
      checkOrigin: (secretRequest) =>
        ALLOWLIST.checkOrigin(secretRequest.origin, { vendor: secretRequest.vendor }),
      timeoutMs: 0,
    });
    const pending = source.resolve(request({ class: "card_cvv", field: "CVV" }));
    // Give the source a tick to open the popup.
    await new Promise((resolve) => setImmediate(resolve));
    const entry = registry.list().at(-1);
    expect(entry?.status).toBe("pending");
    expect(entry?.origin_verified).toBe(true);
    expect(registry.submit(entry?.id ?? "", entry?.token ?? "", CVV)).toBe(true);

    const resolved = await pending;
    expect(resolved?.value).toBe(CVV);
    expect(resolved?.detail).not.toContain(CVV);
    const view = registry.view(entry?.id ?? "");
    expect(view).toMatchObject({ status: "filled", filled_length: 3 });
    expect(JSON.stringify(view)).not.toContain(CVV);
  });

  it("refuses a submission with the wrong form token", async () => {
    const registry = new PopupRegistry();
    const entry = registry.open(request(), ALLOWLIST.checkOrigin("https://tikhub.io/x"));
    expect(registry.submit(entry.id, "not-the-token-not-the-token-xxxx", CARD)).toBe(false);
    expect(registry.submit(entry.id, entry.token, "")).toBe(false);
    expect(registry.get(entry.id)?.status).toBe("pending");
  });

  it("opens blocked, and resolves to nothing, for an unlisted origin", async () => {
    const registry = new PopupRegistry();
    const source = new PopupSecretSource({
      registry,
      urlFor: (id) => `http://127.0.0.1:8788/input/${id}`,
      checkOrigin: (secretRequest) =>
        ALLOWLIST.checkOrigin(secretRequest.origin, { vendor: secretRequest.vendor }),
      timeoutMs: 0,
    });
    const resolved = await source.resolve(request({ origin: "https://evil.example/pay" }));
    expect(resolved).toBeNull();
    const entry = registry.list().at(-1);
    expect(entry?.status).toBe("blocked");
    // A blocked popup cannot be filled at all.
    expect(registry.submit(entry?.id ?? "", entry?.token ?? "", CARD)).toBe(false);
  });

  it("cancels every pending popup at once, for the kill switch", async () => {
    const registry = new PopupRegistry();
    const first = registry.open(request(), ALLOWLIST.checkOrigin("https://tikhub.io/a"));
    const second = registry.open(request(), ALLOWLIST.checkOrigin("https://tikhub.io/b"));
    const waiting = Promise.all([registry.wait(first.id, 0), registry.wait(second.id, 0)]);
    expect(registry.cancelAll()).toBe(2);
    expect(await waiting).toEqual([null, null]);
    expect(registry.get(first.id)?.status).toBe("cancelled");
  });
});
