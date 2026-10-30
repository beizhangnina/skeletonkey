import { describe, expect, it } from "vitest";
import { redactShapes, redactDeepShapes, Redactor, REDACTED } from "../src/redact.js";

/** Values with the shape of the things that must never be logged. */
const CARD = "4242424242424242"; // passes Luhn, test-only
const CVV = "321";
const KEY = "sk-live-FAKE-canary-0123456789abcdef";

describe("redactShapes", () => {
  it("redacts a card number, spaced or dashed", () => {
    for (const written of [CARD, "4242 4242 4242 4242", "4242-4242-4242-4242"]) {
      expect(redactShapes(`paying with ${written}`)).toBe(`paying with ${REDACTED}`);
    }
  });

  it("leaves a long number that is not a card alone", () => {
    // Order numbers, timestamps in micros, byte counts: not cards, not redacted.
    const notACard = "1234567890123";
    expect(redactShapes(`order ${notACard}`)).toContain(notACard);
  });

  it("redacts prefixed vendor keys wherever they appear", () => {
    expect(redactShapes(`Authorization: Bearer ${KEY}`)).not.toContain("0123456789abcdef");
    expect(redactShapes(`key=${KEY}`)).not.toContain("0123456789abcdef");
    expect(redactShapes(`{"api_key": "${KEY}"}`)).not.toContain("0123456789abcdef");
  });

  it("redacts labelled secrets but keeps the label", () => {
    const line = redactShapes(`password=hunter2 cvv:${CVV} otp = 483920 BW_SESSION=abc123def456`);
    expect(line).toContain("password=");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain(CVV);
    expect(line).not.toContain("483920");
    expect(line).not.toContain("abc123def456");
  });

  it("keeps an ordinary log line readable", () => {
    const line = "GET api.voyageai.com/v1/embeddings -> 200 1284b alias=voyage-personal";
    expect(redactShapes(line)).toBe(line);
  });
});

describe("Redactor", () => {
  it("replaces registered values, longest first", () => {
    const redactor = new Redactor([KEY, KEY.slice(0, 12)]);
    const line = redactor.redact(`using ${KEY} now`);
    expect(line).toBe(`using ${REDACTED} now`);
    expect(line).not.toContain("sk-live-FAKE");
  });

  it("ignores values too short to replace safely", () => {
    const redactor = new Redactor(["ab"]);
    expect(redactor.size).toBe(0);
    expect(redactor.redact("a tab is not a secret")).toBe("a tab is not a secret");
  });

  it("redacts deeply through objects and arrays", () => {
    const redactor = new Redactor([KEY]);
    const out = redactor.redactDeep({
      alias: "voyage-personal",
      headers: { authorization: `Bearer ${KEY}` },
      notes: [`card ${CARD}`, "nothing here"],
      bytes: 42,
      nothing: null,
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("0123456789abcdef");
    expect(json).not.toContain(CARD);
    expect(json).toContain("voyage-personal");
    expect(out.bytes).toBe(42);
    expect(out.nothing).toBeNull();
  });

  it("wraps a logger so nothing can be printed unredacted", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    const log = redactor.logger((line) => lines.push(line));
    redactor.add(KEY);
    log(`storing ${KEY} for later`);
    expect(lines).toEqual([`storing ${REDACTED} for later`]);
  });

  it("forgets its values on demand", () => {
    const redactor = new Redactor([KEY]);
    redactor.forget();
    expect(redactor.size).toBe(0);
    // The shape rules still apply, which is why this is a backstop and not a hole.
    expect(redactor.redact(KEY)).toBe(REDACTED);
  });

  it("has a shape-only deep form for processes that hold no secrets", () => {
    const out = redactDeepShapes({ card: CARD, note: "fine" });
    expect(out.card).toBe(REDACTED);
    expect(out.note).toBe("fine");
  });
});
