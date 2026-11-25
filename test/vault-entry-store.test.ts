/**
 * U2: the read/write layer for vault entries.
 *
 * The `Vault` interface did not change -- one alias to one string -- so none
 * of the backends had to move. What this layer adds is the entry shape: a
 * login is one record holding a one-line JSON envelope, and an api_key keeps
 * the v0.3 storage key so nothing has to be migrated.
 *
 * The suite runs the same expectations against the plaintext `file` backend
 * and the real `encrypted-file` backend, because the envelope has to survive
 * both (one record, one line, no newlines).
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfig } from "../src/config.js";
import { upsertKey } from "../src/keys.js";
import { devVaultPath, encryptedVaultPath } from "../src/paths.js";
import { upsertEntry, fieldsFor } from "../src/vault/entries.js";
import { openEntryStore, type VaultEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const USERNAME = "FAKE-canary-USER-0xC0FFEE55";
const PASSWORD = "FAKE-canary-LOGINPW-0xC0FFEE66";
const API_KEY = "sk-test-FAKE-canary-APIKEY-0xC0FFEE11";

const BACKENDS = ["file", "encrypted-file"] as const;


/**
 * What the CLI does in two steps: the secret into the vault, then the
 * metadata row into `entries.yaml` (the v0.3 `skeletonkey add` order, kept so
 * a failed write never leaves a metadata row pointing at nothing).
 */
async function storeLogin(
  store: VaultEntryStore,
  home: string,
  name: string,
  username: string,
  password: string,
): Promise<void> {
  await store.putLogin(name, { username, password });
  upsertEntry(
    {
      name,
      type: "login",
      fields: fieldsFor("login"),
      created: "2026-10-30T12:00:00.000Z",
      last_used: null,
      disabled: false,
    },
    home,
  );
}

describe.each(BACKENDS)("the entry store on the %s backend", (backend) => {
  let home: string;
  let store: VaultEntryStore;

  beforeEach(() => {
    home = makeHome();
    process.env.SKELETONKEY_PASSPHRASE = "correct horse battery staple";
    writeConfig({ email: "dev@example.test", backend, created: "" }, home);
    store = openEntryStore(home);
  });
  afterEach(() => {
    delete process.env.SKELETONKEY_PASSPHRASE;
    removeHome(home);
  });

  it("stores a login as exactly one record, on one line", async () => {
    await storeLogin(store, home, "github-login", USERNAME, PASSWORD);

    const raw = await store.vault.get("login/github-login");
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("\n");
    expect(JSON.parse(raw as string)).toEqual({
      v: 1,
      type: "login",
      username: USERNAME,
      password: PASSWORD,
      totp: null,
    });

    // One record, under the login namespace. The api_key storage key is
    // untouched by a login.
    expect(await store.vault.get("github-login")).toBeNull();
  });

  it("reads back the username and the password", async () => {
    await storeLogin(store, home, "github-login", USERNAME, PASSWORD);
    const entry = store.resolve("github-login");
    expect(entry).not.toBeNull();
    expect(entry?.type).toBe("login");
    expect(entry?.fields).toEqual(["username", "password"]);

    expect(await store.getField(entry!, "username")).toBe(USERNAME);
    expect(await store.getField(entry!, "password")).toBe(PASSWORD);
  });

  it("returns null for a field the entry does not have", async () => {
    await storeLogin(store, home, "github-login", USERNAME, PASSWORD);
    const entry = store.resolve("github-login")!;
    expect(await store.getField(entry, "totp")).toBeNull();
    expect(await store.getField(entry, "nonsense")).toBeNull();
  });

  it("returns null when the vault has no record for the entry", async () => {
    const entry = store.resolve("github-login");
    expect(entry).toBeNull();
  });

  it("keeps an api_key under its v0.3 storage key", async () => {
    await store.putApiKey("voyage-personal", API_KEY);
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

    const entry = store.resolve("voyage-personal");
    expect(entry?.type).toBe("api_key");
    expect(entry?.fields).toEqual(["api_key"]);
    expect(entry?.target).toBe("api.voyageai.com");
    expect(await store.getField(entry!, "api_key")).toBe(API_KEY);
  });

  it("lists both kinds of entry", async () => {
    await store.putLogin("github-login", { username: USERNAME, password: PASSWORD });
    await store.putApiKey("voyage-personal", API_KEY);
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
      },
      home,
    );

    expect(store.list().map((entry) => entry.name)).toEqual(["github-login", "voyage-personal"]);
  });

  it("deletes the record and the metadata row together", async () => {
    await storeLogin(store, home, "github-login", USERNAME, PASSWORD);

    expect(await store.deleteEntry("github-login")).toBe(true);
    expect(await store.vault.get("login/github-login")).toBeNull();
    expect(store.resolve("github-login")).toBeNull();
    expect(store.list()).toHaveLength(0);
    // Nothing left to delete.
    expect(await store.deleteEntry("github-login")).toBe(false);
  });

  it("keeps the secret out of the metadata file", async () => {
    await storeLogin(store, home, "github-login", USERNAME, PASSWORD);
    const metadata = fs.readFileSync(`${home}/entries.yaml`, "utf8");
    expect(metadata).not.toContain(PASSWORD);
    expect(metadata).not.toContain(USERNAME);
  });
});

describe("the entry store on the plaintext file backend", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "" }, home);
  });
  afterEach(() => {
    removeHome(home);
  });

  it("stores the secrets in the one plaintext file the test backend uses", async () => {
    const store = openEntryStore(home);
    await store.putLogin("github-login", { username: USERNAME, password: PASSWORD });
    const raw = fs.readFileSync(devVaultPath(home), "utf8");
    expect(raw).toContain("login/github-login");
    expect(raw).toContain(PASSWORD);
    expect(fs.statSync(devVaultPath(home)).mode & 0o777).toBe(0o600);
  });
});

describe("the entry store on the encrypted-file backend", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    process.env.SKELETONKEY_PASSPHRASE = "correct horse battery staple";
    writeConfig({ email: "dev@example.test", backend: "encrypted-file", created: "" }, home);
  });
  afterEach(() => {
    delete process.env.SKELETONKEY_PASSPHRASE;
    removeHome(home);
  });

  it("keeps the secret out of the file on disk", async () => {
    const store = openEntryStore(home);
    await store.putLogin("github-login", { username: USERNAME, password: PASSWORD });
    const raw = fs.readFileSync(encryptedVaultPath(home), "utf8");
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(USERNAME);
  });

  it("refuses to open when the passphrase is wrong", async () => {
    const store = openEntryStore(home);
    await store.putLogin("github-login", { username: USERNAME, password: PASSWORD });
    process.env.SKELETONKEY_PASSPHRASE = "the wrong passphrase";
    const reopened = openEntryStore(home);
    await expect(reopened.checkBackend()).rejects.toThrow(/not usable/);
  });
});
