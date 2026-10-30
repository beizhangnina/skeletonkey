/**
 * The domain allowlist the runner enforces (§5a, §9).
 *
 * A secret is only ever filled on a domain that the API index (or a key already
 * in the vault) says belongs to the vendor. Everything else is blocked and the
 * human is told -- that is the defence against a lookalike domain and against a
 * vendor page talking the runner into typing a card somewhere else.
 *
 * The list is built from facts already on disk, never from anything an agent
 * passed in on this call.
 */
import { loadApiIndex, type IndexEntry } from "./apis.js";
import { domainMatches, normalizeDomain, readKeys } from "./keys.js";
import { isLoopbackHost } from "./proxy.js";
import { skeletonKeyHome } from "./paths.js";

export interface AllowlistEntry {
  domain: string;
  /** Vendor the domain belongs to, for the message shown to the human. */
  vendor: string;
  /** `api-index`, `user-index` or `vault` -- where the domain was learned. */
  source: string;
}

export interface OriginCheck {
  allowed: boolean;
  /** Normalised host that was checked. */
  host: string;
  /** The allowlist row that permitted it, when one did. */
  matched: AllowlistEntry | null;
  reason: string;
}

export class Allowlist {
  constructor(private readonly entries: AllowlistEntry[]) {}

  get size(): number {
    return this.entries.length;
  }

  domains(): string[] {
    return [...new Set(this.entries.map((entry) => entry.domain))].sort();
  }

  /** Rows for one vendor, so the approval page can show what is covered. */
  forVendor(vendor: string): AllowlistEntry[] {
    const name = vendor.trim().toLowerCase();
    return this.entries.filter((entry) => entry.vendor.toLowerCase() === name);
  }

  /** A host is allowed when an allowlisted domain covers it (or equals it). */
  check(hostOrUrl: string, options: { vendor?: string } = {}): OriginCheck {
    const host = hostFrom(hostOrUrl);
    if (host === "") {
      return { allowed: false, host, matched: null, reason: "Not a host or an absolute URL." };
    }
    const candidates =
      options.vendor === undefined ? this.entries : this.forVendor(options.vendor);
    const matched = candidates.find((entry) => domainMatches(entry.domain, host)) ?? null;
    if (matched === null) {
      return {
        allowed: false,
        host,
        matched: null,
        reason:
          `${host} is not on SkeletonKey's domain allowlist` +
          (options.vendor === undefined ? "" : ` for ${options.vendor}`) +
          ". No secret is filled on an unlisted origin: a lookalike domain is exactly what this " +
          "check exists to stop.",
      };
    }
    return {
      allowed: true,
      host,
      matched,
      reason: `${host} is covered by ${matched.domain} (${matched.source}: ${matched.vendor}).`,
    };
  }

  /**
   * The check the Secure Input Popup shows: the origin has to be allowlisted
   * *and* https, because a secret typed into a plain-HTTP vendor page is
   * already lost. Loopback is exempt (it never leaves the machine).
   */
  checkOrigin(origin: string, options: { vendor?: string } = {}): OriginCheck {
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      url = null;
    }
    if (url === null) {
      const bare = this.check(origin, options);
      return bare.allowed
        ? {
            ...bare,
            allowed: false,
            reason: `${origin} is not an absolute URL, so its scheme cannot be verified.`,
          }
        : bare;
    }
    const host = normalizeDomain(url.host);
    if (url.protocol !== "https:" && !isLoopbackHost(host)) {
      return {
        allowed: false,
        host,
        matched: null,
        reason: `${origin} is not https, so anything typed into it would travel in clear.`,
      };
    }
    return this.check(host, options);
  }
}

export interface BuildAllowlistOptions {
  home?: string;
  apisFile?: string;
  shardDirs?: string[];
  userIndexFile?: string | null;
  /** Extra domains a human put in the config. Rare; kept for completeness. */
  extra?: { domain: string; vendor: string }[];
}

/** Builds the allowlist from the API index and the keys already in the vault. */
export function buildAllowlist(options: BuildAllowlistOptions = {}): Allowlist {
  const home = options.home ?? skeletonKeyHome();
  const index = loadApiIndex({
    home,
    ...(options.apisFile === undefined ? {} : { apisFile: options.apisFile }),
    ...(options.shardDirs === undefined ? {} : { shardDirs: options.shardDirs }),
    ...(options.userIndexFile === undefined ? {} : { userIndexFile: options.userIndexFile }),
  });
  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined, vendor: string, source: string): void => {
    const domain = hostFrom(raw ?? "");
    if (domain === "") return;
    const dedupe = `${source}:${vendor}:${domain}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    entries.push({ domain, vendor, source });
  };

  for (const entry of index.entries) {
    const source = entry.origin === "user" ? "user-index" : "api-index";
    for (const field of indexDomains(entry)) push(field, entry.name, source);
  }
  for (const key of readKeys(home).keys) push(key.domain, key.platform, "vault");
  for (const extra of options.extra ?? []) push(extra.domain, extra.vendor, "config");

  return new Allowlist(entries);
}

function indexDomains(entry: IndexEntry): (string | null | undefined)[] {
  return [entry.domain, entry.base_url, entry.signup_url, entry.key_page_url, entry.url];
}

/** Hostname out of a URL, a bare host, or junk (`""`). */
export function hostFrom(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed.includes("://")) {
    try {
      return normalizeDomain(new URL(trimmed).host);
    } catch {
      return "";
    }
  }
  const host = normalizeDomain(trimmed);
  // Reject anything that is not plausibly a hostname, so a path or a sentence
  // cannot become an allowlist row.
  if (!/^[a-z0-9.\-:[\]]+$/.test(host)) return "";
  if (!host.includes(".") && !isLoopbackHost(host)) return "";
  return host;
}
