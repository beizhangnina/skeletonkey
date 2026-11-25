import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findAccount,
  isValidAccountName,
  isValidRegisteredDate,
  isValidVendorId,
  readAccounts,
  removeAccount,
  todayLocalDate,
  upsertAccount,
  vendorKnown,
  type AccountMeta,
} from "../src/accounts/store.js";
import { accountsPath } from "../src/paths.js";
import { makeHome, removeHome } from "./helpers/env.js";

function account(overrides: Partial<AccountMeta> = {}): AccountMeta {
  return {
    name: "apify-main",
    vendor: "apify",
    registered: "2026-01-02",
    email_hint: "b**********@gmail.com",
    key_alias: "apify-main",
    login_entry: null,
    created: "2026-01-02T00:00:00.000Z",
    disabled: false,
    disabled_at: null,
    ...overrides,
  };
}

describe("account name and vendor validation", () => {
  it("accepts the same name shape as vault entries", () => {
    expect(isValidAccountName("apify-main")).toBe(true);
    expect(isValidAccountName("a")).toBe(true);
    expect(isValidAccountName("A1.b_c-d")).toBe(true);
    expect(isValidAccountName(".leading-dot")).toBe(false);
    expect(isValidAccountName("has space")).toBe(false);
    expect(isValidAccountName("a".repeat(65))).toBe(false);
  });

  it("requires a lower-case vendor id", () => {
    expect(isValidVendorId("apify")).toBe(true);
    expect(isValidVendorId("api-fy_9")).toBe(true);
    expect(isValidVendorId("Apify")).toBe(false);
    expect(isValidVendorId("")).toBe(false);
    expect(isValidVendorId("-apify")).toBe(false);
  });

  it("validates real calendar dates only", () => {
    expect(isValidRegisteredDate("2026-11-24")).toBe(true);
    expect(isValidRegisteredDate("2024-02-29")).toBe(true); // leap day
    expect(isValidRegisteredDate("2023-02-29")).toBe(false); // not a leap year
    expect(isValidRegisteredDate("2026-13-01")).toBe(false);
    expect(isValidRegisteredDate("2026-11-31")).toBe(false);
    expect(isValidRegisteredDate("not-a-date")).toBe(false);
  });

  it("today's date is a well-formed, valid date", () => {
    const today = todayLocalDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isValidRegisteredDate(today)).toBe(true);
  });
});

describe("vendorKnown", () => {
  it("finds a vendor id that exists in the bundled index", () => {
    // `treg` is a real, lower-case apis.yaml entry name.
    expect(vendorKnown("treg")).toBe(true);
    expect(vendorKnown("TREG")).toBe(true); // case-insensitive
  });

  it("returns false for a vendor id that is not in the index", () => {
    expect(vendorKnown("totally-unknown-vendor-xyz-0001")).toBe(false);
  });

  it("finds a shard id folded into a same-domain apis.yaml entry", () => {
    // `apify` and `apollo` are real `data/apis/*.yaml` shard ids, but the merge
    // in `loadApiIndex` folds each into an apis.yaml entry that shares its
    // registrable domain (`example-apify-scraping`, `example-apollo-contacts`),
    // so the shard id never reaches `index.entries` -- vendorKnown has to go
    // back to the shard files directly to find it.
    expect(vendorKnown("apify")).toBe(true);
    expect(vendorKnown("apollo")).toBe(true);
    expect(vendorKnown("no-such-vendor-zz")).toBe(false);
  });
});

describe("the accounts.yaml store", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("round-trips an account through upsert/find/remove", () => {
    expect(readAccounts(home).accounts).toEqual([]);
    upsertAccount(account(), home);
    expect(findAccount("apify-main", home)).toEqual(account());

    upsertAccount(account({ disabled: true, disabled_at: "2026-02-01T00:00:00.000Z" }), home);
    expect(findAccount("apify-main", home)?.disabled).toBe(true);

    expect(removeAccount("apify-main", home)).toBe(true);
    expect(findAccount("apify-main", home)).toBeUndefined();
    expect(removeAccount("apify-main", home)).toBe(false);
  });

  it("writes the file at mode 0600 with a no-secrets header", () => {
    upsertAccount(account(), home);
    const file = accountsPath(home);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("NO SECRET VALUES ARE STORED HERE");
    expect(text).toContain("version: 1");
  });

  it("is tolerant of a missing file", () => {
    expect(readAccounts(home)).toEqual({ version: 1, accounts: [] });
  });

  it("skips bad rows (no name, no vendor) without crashing, and ignores unknown fields", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      accountsPath(home),
      [
        "version: 1",
        "accounts:",
        "  - name: good-one",
        "    vendor: apify",
        "    registered: 2026-01-01",
        "    some_future_field: whatever",
        "  - vendor: no-name-vendor", // no name -> skipped
        "  - name: no-vendor-account", // no vendor -> skipped
        "",
      ].join("\n"),
      "utf8",
    );
    const parsed = readAccounts(home);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.name).toBe("good-one");
  });
});
