export const BACKENDS = [
  "bitwarden",
  "1password",
  "keychain",
  "encrypted-file",
  "file",
] as const;
export type BackendId = (typeof BACKENDS)[number];

/**
 * Backends a human should pick from. `file` is plaintext and exists only so the
 * test suite and `scripts/demo.sh` can run without any vault installed.
 */
export const PUBLIC_BACKENDS: readonly BackendId[] = [
  "bitwarden",
  "1password",
  "keychain",
  "encrypted-file",
];

export const TEST_ONLY_BACKENDS: readonly BackendId[] = ["file"];

/** Config files written by older versions used different ids. */
const BACKEND_ALIASES: Record<string, BackendId> = {
  "macos-keychain": "keychain",
  "macos_keychain": "keychain",
  "op": "1password",
  "bw": "bitwarden",
};

export function isBackendId(value: string): value is BackendId {
  return (BACKENDS as readonly string[]).includes(value);
}

export function isTestOnlyBackend(value: BackendId): boolean {
  return TEST_ONLY_BACKENDS.includes(value);
}

/** Resolves a config/CLI string to a backend id, following legacy aliases. */
export function resolveBackendId(value: string): BackendId | null {
  const trimmed = value.trim();
  if (isBackendId(trimmed)) return trimmed;
  return BACKEND_ALIASES[trimmed] ?? null;
}

/** Port the proxy listens on when neither config nor a flag says otherwise. */
export const DEFAULT_PROXY_PORT = 8787;

/** How the local proxy listens when it is *not* in gateway mode. */
export interface ProxyConfig {
  /** Address to bind. Defaults to 127.0.0.1. */
  bind?: string;
  port?: number;
}

/** How the proxy listens in gateway mode (`skeletonkey proxy --gateway`). */
export interface GatewayConfig {
  /**
   * Address to bind, or the literal `tailscale` to resolve this host's tailnet
   * address with `tailscale ip -4`.
   */
  bind?: string;
  port?: number;
  /** Shared secret other devices must send as `X-SkeletonKey-Token`. */
  token?: string;
  /** Explicit opt-in to binding every interface (0.0.0.0 / ::). */
  allow_all_interfaces?: boolean;
  /** Address used when `bind: tailscale` cannot be resolved. */
  fallback_bind?: string;
}

export interface Config {
  /** Dedicated email used to sign up for API accounts and to label vault items. */
  email: string;
  backend: BackendId;
  /** 1Password vault name, only meaningful for the `1password` backend. */
  op_vault?: string;
  /** Bitwarden folder name, only meaningful for the `bitwarden` backend. */
  bw_folder?: string;
  proxy?: ProxyConfig;
  gateway?: GatewayConfig;
  created: string;
}

/** Scheme the proxy uses to reach an upstream in reverse (`/<domain>/<path>`) mode. */
export const UPSTREAM_SCHEMES = ["https", "http"] as const;
export type UpstreamScheme = (typeof UPSTREAM_SCHEMES)[number];

export function isUpstreamScheme(value: string): value is UpstreamScheme {
  return (UPSTREAM_SCHEMES as readonly string[]).includes(value);
}

export interface KeyMeta {
  alias: string;
  platform: string;
  domain: string;
  /** Header name to inject, e.g. `Authorization`. */
  header: string;
  /** Header value template containing the `{key}` placeholder, e.g. `Bearer {key}`. */
  format: string;
  created: string;
  last_used: string | null;
  disabled: boolean;
  /**
   * Scheme for this key's domain in reverse mode. Undefined means "decide per
   * host": https, except for loopback addresses. Set it to `http` only for a
   * vendor you reach over plain HTTP on purpose -- a key goes into that header.
   */
  scheme?: UpstreamScheme;
}

export interface KeysFile {
  version: 1;
  keys: KeyMeta[];
}

export interface LedgerRow {
  id: number;
  alias: string | null;
  domain: string;
  timestamp: string;
  status: number | null;
  bytes: number;
  cost: number | null;
}
