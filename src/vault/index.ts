import { readConfig } from "../config.js";
import { skeletonKeyHome } from "../paths.js";
import { isTestOnlyBackend, type BackendId, type Config } from "../types.js";
import { BitwardenVault } from "./bitwarden.js";
import { EncryptedFileVault } from "./encrypted-file.js";
import { FileVault } from "./file.js";
import { KeychainVault } from "./keychain.js";
import { OnePasswordVault } from "./onepassword.js";
import type { Vault } from "./types.js";

export type { Vault } from "./types.js";
export { BitwardenVault } from "./bitwarden.js";
export { EncryptedFileVault, decryptSecrets, encryptSecrets } from "./encrypted-file.js";
export { FileVault } from "./file.js";
export { KeychainVault } from "./keychain.js";
export { OnePasswordVault } from "./onepassword.js";

/** Set to use the plaintext `file` backend; the test suite and demo do. */
export const TEST_BACKEND_ENV = "SKELETONKEY_ALLOW_TEST_BACKEND";

export function testBackendAllowed(): boolean {
  const value = process.env[TEST_BACKEND_ENV];
  return value !== undefined && value !== "" && value !== "0";
}

export function createVault(config: Config, home = skeletonKeyHome()): Vault {
  const backend: BackendId = config.backend;
  if (isTestOnlyBackend(backend) && !testBackendAllowed()) {
    throw new Error(
      `The \`${backend}\` backend stores secrets in plaintext and exists only for this ` +
        `repo's tests and demo. Set ${TEST_BACKEND_ENV}=1 to use it anyway, or pick ` +
        "bitwarden, 1password, keychain, or encrypted-file.",
    );
  }
  switch (backend) {
    case "bitwarden":
      return new BitwardenVault(config.bw_folder);
    case "1password":
      return new OnePasswordVault(config.op_vault ?? "Private", home);
    case "keychain":
      return new KeychainVault(config.email);
    case "encrypted-file":
      return new EncryptedFileVault(home);
    case "file":
      return new FileVault(home);
  }
}

export function openVault(home = skeletonKeyHome()): Vault {
  return createVault(readConfig(home), home);
}
