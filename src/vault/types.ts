import type { BackendId } from "../types.js";

export interface Vault {
  readonly id: BackendId;
  /** Human-readable description of where the secret ends up. */
  readonly location: string;
  /**
   * True for backends that must never hold a real key. Hidden from `skeletonkey
   * init`'s menu and refused unless SKELETONKEY_ALLOW_TEST_BACKEND is set.
   */
  readonly testOnly: boolean;
  /** Throws with an actionable message when the backend cannot be used here. */
  check(): Promise<void>;
  set(alias: string, secret: string): Promise<void>;
  get(alias: string): Promise<string | null>;
  delete(alias: string): Promise<void>;
}
