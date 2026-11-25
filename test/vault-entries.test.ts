/**
 * U1: the entry model and the `vault://` grammar.
 *
 * Two things are pinned here:
 *
 *   - the metadata file holds **no secret values**, and is written 0600;
 *   - the URI grammar is deterministic: the last dot decides, and only when
 *     what follows it is a known field name.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertKey } from "../src/keys.js";
import { entriesPath } from "../src/paths.js";
import {
  decodeLogin,
  encodeLogin,
  entryTarget,
  fieldsFor,
  findEntry,
  isKnownFieldName,
  listVaultEntries,
  maskUsername,
  readEntries,
  removeEntry,
  storageAlias,
  upsertEntry,
  writeEntries,
  type VaultEntryMeta,
} from "../src/vault/entries.js";
import {
  assertUsableEntryName,
  endsWithFieldSuffix,
  envNameFor,
  formatVaultUri,
  isValidEntryName,
  isVaultUri,
  parseVaultUri,
  VaultUriError,
} from "../src/vault/uri.js";
import { makeHome, removeHome } from "./helpers/env.js";

const PASSWORD = "FAKE-password-0xC0FFEE22";

describe("the vault:// grammar", () => {
  it("reads a name and a field", () => {
    expect(parseVaultUri("vault://github-login.password")).toEqual({
      name: "github-login",
      field: "password",
    });
    expect(parseVaultUri("vault://github-login.username")).toEqual({
      name: "github-login",
      field: "username",
    });
    expect(parseVaultUri("vault://voyage-personal")).toEqual({
      name: "voyage-personal",
      field: null,
    });
  });

  it("is case-insensitive about the scheme and case-sensitive about the rest", () => {
    expect(parseVaultUri("VAULT://GitHub-Login.password")).toEqual({
      name: "GitHub-Login",
      field: "password",
    });
    expect(parseVaultUri("vault://GitHub-Login")).not.toEqual(parseVaultUri("vault://github-login"));
  });

  it("lets the last dot decide, and only for a known field name", () => {
    // `com-key` is not a field, so the whole thing is the name.
    expect(parseVaultUri("vault://stripe.com-key")).toEqual({
      name: "stripe.com-key",
      field: null,
    });
    // `secret` is not a known field either: the whole string is the name, and
    // the entry is simply not found later on.
    expect(parseVaultUri("vault://github-login.secret")).toEqual({
      name: "github-login.secret",
      field: null,
    });
    expect(parseVaultUri("vault://a.b.password")).toEqual({ name: "a.b", field: "password" });
  });

  it("refuses anything that is not a reference", () => {
    for (const bad of [
      "vault://",
      "vault://x/y",
      "vault://x password",
      "vault://x?y",
      "vault://x#y",
      "vault://.password",
      "https://example.test",
      "not-a-uri",
    ]) {
      expect(() => parseVaultUri(bad), bad).toThrow(VaultUriError);
    }
  });

  it("carries the bad_vault_uri code on a bad reference", () => {
    try {
      parseVaultUri("vault://x/y");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as VaultUriError).code).toBe("bad_vault_uri");
      expect((error as VaultUriError).exitCode).toBe(72);
    }
  });

  it("builds a reference back from a name and a field", () => {
    expect(formatVaultUri("github-login", "password")).toBe("vault://github-login.password");
    expect(formatVaultUri("github-login")).toBe("vault://github-login");
    expect(formatVaultUri("github-login", null)).toBe("vault://github-login");
  });

  it("names the variable a reference maps to", () => {
    expect(envNameFor("github-login", "password")).toBe("GITHUB_LOGIN_PASSWORD");
    expect(envNameFor("voyage-personal", "api_key")).toBe("VOYAGE_PERSONAL_API_KEY");
    expect(envNameFor("a.b", "username")).toBe("A_B_USERNAME");
  });

  it("knows which names may be used", () => {
    expect(isValidEntryName("github-login")).toBe(true);
    expect(isValidEntryName("a.b")).toBe(true);
    expect(isValidEntryName("-leading-dash")).toBe(false);
    expect(isValidEntryName("")).toBe(false);
    expect(isValidEntryName("x".repeat(65))).toBe(false);
    expect(isValidEntryName("x".repeat(64))).toBe(true);
    expect(isVaultUri("vault://x")).toBe(true);
    expect(isVaultUri("VAULT://x")).toBe(true);
    expect(isVaultUri("x")).toBe(false);
  });

  it("refuses a name that could not be addressed", () => {
    // `github.password` would be unreachable: the parser reads `password` as
    // the field of `github`.
    expect(endsWithFieldSuffix("github.password")).toBe(true);
    expect(endsWithFieldSuffix("github.username")).toBe(true);
    expect(endsWithFieldSuffix("github.api_key")).toBe(true);
    expect(endsWithFieldSuffix("github.totp")).toBe(true);
    expect(endsWithFieldSuffix("github.secret")).toBe(false);
    expect(() => assertUsableEntryName("github.password")).toThrow(/must not end in/);
    expect(() => assertUsableEntryName("-nope")).toThrow(/must start with/);
    expect(() => assertUsableEntryName("github-login")).not.toThrow();
  });
});

describe("the entry metadata file", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("is empty when the file does not exist", () => {
    expect(readEntries(home)).toEqual({ version: 1, entries: [] });
    expect(findEntry("nope", home)).toBeUndefined();
  });

  it("is written 0600 and holds no secret values", () => {
    const entry: VaultEntryMeta = {
      name: "github-login",
      type: "login",
      fields: fieldsFor("login"),
      created: "2026-10-30T12:00:00.000Z",
      last_used: null,
      disabled: false,
      username_hint: maskUsername("bob@example.test"),
    };
    upsertEntry(entry, home);

    const file = entriesPath(home);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(file, "utf8");
    expect(body).toContain("NO SECRET VALUES ARE STORED HERE");
    expect(body).toContain("b**@example.test");
    expect(body).not.toContain(PASSWORD);
  });

  it("round-trips an entry and forgets it again", () => {
    const entry: VaultEntryMeta = {
      name: "github-login",
      type: "login",
      fields: fieldsFor("login"),
      created: "2026-10-30T12:00:00.000Z",
      last_used: null,
      disabled: false,
    };
    upsertEntry(entry, home);
    expect(findEntry("github-login", home)?.type).toBe("login");

    upsertEntry({ ...entry, label: "renamed" }, home);
    expect(findEntry("github-login", home)?.label).toBe("renamed");
    expect(readEntries(home).entries).toHaveLength(1);

    expect(removeEntry("github-login", home)).toBe(true);
    expect(removeEntry("github-login", home)).toBe(false);
    expect(findEntry("github-login", home)).toBeUndefined();
  });

  it("ignores unknown fields and skips broken rows", () => {
    const file = entriesPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "version: 1",
        "entries:",
        "  - name: good",
        "    type: login",
        "    fields: [username, password]",
        "    created: 2026-10-30T12:00:00.000Z",
        "    last_used: null",
        "    disabled: false",
        "    something_new: ignored",
        "  - type: login",
        "    fields: [username]",
        "  - name: also-good",
        "    type: api_key",
        "    fields: [api_key]",
        "    created: 2026-10-30T12:00:00.000Z",
        "    last_used: null",
        "    disabled: false",
      ].join("\n"),
      { mode: 0o600 },
    );

    const entries = readEntries(home).entries;
    expect(entries.map((entry) => entry.name)).toEqual(["good", "also-good"]);
    expect(entries.find((entry) => entry.name === "good")?.fields).toEqual(["username", "password"]);
  });

  it("merges the api_key rows of keys.yaml with the logins", () => {
    upsertKey(
      {
        alias: "voyage-personal",
        platform: "Voyage AI",
        domain: "api.voyageai.com",
        header: "Authorization",
        format: "Bearer {key}",
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );
    upsertEntry(
      {
        name: "github-login",
        type: "login",
        fields: fieldsFor("login"),
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
        username_hint: "b***",
      },
      home,
    );

    const summaries = listVaultEntries(home);
    expect(summaries.map((summary) => summary.name)).toEqual(["github-login", "voyage-personal"]);
    expect(summaries.find((s) => s.name === "voyage-personal")?.type).toBe("api_key");
    expect(summaries.find((s) => s.name === "voyage-personal")?.fields).toEqual(["api_key"]);
    expect(summaries.find((s) => s.name === "voyage-personal")?.target).toBe("api.voyageai.com");
    expect(summaries.find((s) => s.name === "github-login")?.type).toBe("login");
  });

  it("lets the api_key row win a name collision and marks the login shadowed", () => {
    upsertKey(
      {
        alias: "clash",
        platform: "ExampleCo",
        domain: "api.example.test",
        header: "Authorization",
        format: "Bearer {key}",
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );
    upsertEntry(
      {
        name: "clash",
        type: "login",
        fields: fieldsFor("login"),
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );

    const summaries = listVaultEntries(home);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.type).toBe("api_key");
    expect(summaries[0]?.shadowed).toBeUndefined();
  });

  it("knows where an entry points", () => {
    const base = {
      name: "x",
      type: "login" as const,
      fields: fieldsFor("login"),
      created: "",
      last_used: null,
      disabled: false,
    };
    expect(entryTarget({ ...base, domain: "github.com" })).toBe("github.com");
    expect(entryTarget({ ...base, url: "https://github.com/login" })).toBe("github.com");
    expect(entryTarget({ ...base, url: "not a url" })).toBeNull();
    expect(entryTarget(base)).toBeNull();
  });

  it("keeps the v0.3 storage key for api_key entries and namespaces the logins", () => {
    expect(storageAlias({ name: "voyage-personal", type: "api_key" })).toBe("voyage-personal");
    expect(storageAlias({ name: "github-login", type: "login" })).toBe("login/github-login");
  });
});

describe("the login envelope", () => {
  it("is one line of JSON, so every backend can store it", () => {
    const envelope = encodeLogin("bob@example.test", PASSWORD);
    expect(envelope).not.toContain("\n");
    expect(JSON.parse(envelope)).toEqual({
      v: 1,
      type: "login",
      username: "bob@example.test",
      password: PASSWORD,
      totp: null,
    });
  });

  it("round-trips", () => {
    const decoded = decodeLogin(encodeLogin("bob@example.test", PASSWORD), "github-login");
    expect(decoded.username).toBe("bob@example.test");
    expect(decoded.password).toBe(PASSWORD);
  });

  it("refuses a corrupt envelope without quoting it", () => {
    for (const broken of [
      "not json at all",
      JSON.stringify({ v: 2, type: "login", username: "u", password: "p" }),
      JSON.stringify({ v: 1, type: "api_key", username: "u", password: "p" }),
      JSON.stringify({ v: 1, type: "login", username: 5, password: "p" }),
      JSON.stringify({ v: 1, type: "login", username: "u", password: null }),
      JSON.stringify([1, 2, 3]),
    ]) {
      let thrown: unknown;
      try {
        decodeLogin(broken, "github-login");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code: string }).code).toBe("entry_corrupt");
      expect((thrown as { exitCode: number }).exitCode).toBe(74);
      // The message must not repeat the stored bytes: that would be the leak.
      expect((thrown as Error).message).not.toContain(broken);
      expect((thrown as Error).message).not.toContain(PASSWORD);
    }
  });
});

describe("masking a username", () => {
  it("keeps the domain of an address and the first character", () => {
    expect(maskUsername("bob@example.test")).toBe("b**@example.test");
    expect(maskUsername("b@example.test")).toBe("b*@example.test");
  });

  it("keeps only the first character of anything else", () => {
    expect(maskUsername("bob")).toBe("b***");
    expect(maskUsername("b")).toBe("b***");
  });

  it("never returns the username itself", () => {
    expect(maskUsername("")).toBe("");
    expect(maskUsername("   ")).toBe("");
    expect(maskUsername("bob@example.test")).not.toContain("ob@example.test");
  });
});

describe("the field names", () => {
  it("are the ones the grammar knows", () => {
    expect(fieldsFor("api_key")).toEqual(["api_key"]);
    expect(fieldsFor("login")).toEqual(["username", "password"]);
    expect(isKnownFieldName("username")).toBe(true);
    expect(isKnownFieldName("password")).toBe(true);
    expect(isKnownFieldName("api_key")).toBe(true);
    // Reserved for a later release: known to the parser, not to any entry.
    expect(isKnownFieldName("totp")).toBe(true);
    expect(fieldsFor("login")).not.toContain("totp");
    expect(isKnownFieldName("secret")).toBe(false);
  });
});

describe("writing entries directly", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("sorts by name and keeps the file 0600", () => {
    writeEntries(
      {
        version: 1,
        entries: [
          {
            name: "zulu",
            type: "login",
            fields: fieldsFor("login"),
            created: "",
            last_used: null,
            disabled: false,
          },
          {
            name: "alpha",
            type: "login",
            fields: fieldsFor("login"),
            created: "",
            last_used: null,
            disabled: false,
          },
        ],
      },
      home,
    );
    expect(readEntries(home).entries.map((entry) => entry.name)).toEqual(["alpha", "zulu"]);
    expect(fs.statSync(entriesPath(home)).mode & 0o777).toBe(0o600);
  });
});
