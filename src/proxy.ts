import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { readConfig } from "./config.js";
import { killSwitchState } from "./killswitch.js";
import { domainMatches, normalizeDomain, readKeys, touchLastUsed } from "./keys.js";
import { Ledger, openLedger } from "./ledger.js";
import { skeletonKeyHome } from "./paths.js";
import { globalRedactor, Redactor } from "./redact.js";
import type { KeyMeta, UpstreamScheme } from "./types.js";
import { createVault, type Vault } from "./vault/index.js";

/** Headers the client is never allowed to pass upstream through the proxy. */
const CLIENT_AUTH_HEADERS = [
  "authorization",
  // The gateway token authenticates the caller to us; it never goes upstream.
  "x-skeletonkey-token",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
];

/** Hop-by-hop headers that must not be forwarded (RFC 9110 7.6.1). */
const HOP_BY_HOP = [
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
];

/** Upstream headers we accept as a self-reported price for a call. */
const COST_HEADERS = ["x-skeletonkey-cost-usd", "x-cost-usd", "x-request-cost-usd"];

export interface ProxyOptions {
  port: number;
  host?: string;
  home?: string;
  /**
   * Global override for the reverse-mode (`/<domain>/<path>`) scheme. Omit it
   * and the scheme is decided per host: a key's own `scheme`, else http for a
   * loopback address, else https. Kept for compatibility with `--upstream-scheme`.
   */
  upstreamScheme?: UpstreamScheme;
  /**
   * Shared secret callers must send as `X-SkeletonKey-Token`. Required in gateway
   * mode; ignored (and not checked) when `requireToken` is false.
   */
  token?: string | null;
  /** Enforce the `X-SkeletonKey-Token` header on every request but /__skeletonkey/health. */
  requireToken?: boolean;
  logger?: (line: string) => void;
  ledger?: Ledger;
  vault?: Vault;
}

export interface ProxyHandle {
  port: number;
  host: string;
  url: string;
  /** True when callers must send a matching `X-SkeletonKey-Token`. */
  requireToken: boolean;
  close(): Promise<void>;
}

interface Target {
  url: URL;
  mode: "forward" | "reverse";
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const home = options.home ?? skeletonKeyHome();
  const host = options.host ?? "127.0.0.1";
  const schemeOverride = options.upstreamScheme ?? null;
  const config = readConfig(home);
  const token = options.token ?? null;
  const requireToken = options.requireToken === true;
  if (requireToken && (token === null || token === "")) {
    throw new Error("requireToken was set but no token was supplied.");
  }
  const vault = options.vault ?? createVault(config, home);
  const ledger = options.ledger ?? openLedger(home);
  const ownLedger = options.ledger === undefined;
  const secretCache = new Map<string, string>();

  /**
   * Every line goes through the shared redactor: known values (anything this
   * process has loaded out of the vault) plus secret *shapes* (card numbers,
   * bearer tokens, `password=` assignments).
   */
  const redactor = new Redactor();
  const log = redactor.logger(options.logger ?? ((text: string) => console.log(text)));

  const secretFor = async (alias: string): Promise<string | null> => {
    const cached = secretCache.get(alias);
    if (cached !== undefined) return cached;
    const secret = await vault.get(alias);
    if (secret === null) return null;
    secretCache.set(alias, secret);
    // Registered before it can appear in any later line.
    redactor.add(secret);
    globalRedactor.add(secret);
    return secret;
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      log(`! proxy error: ${describe(error)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "proxy_error" }));
    });
  });

  // A CONNECT tunnel is end-to-end TLS; the proxy cannot inject a header into
  // it, so refuse rather than silently passing traffic through unauthenticated.
  server.on("connect", (_req, socket) => {
    socket.write(
      "HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    );
    socket.destroy();
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.url === "/__skeletonkey/health") {
      // Left unauthenticated on purpose: it reveals nothing but liveness, and
      // other devices need it to wait for the gateway to come up.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          upstreamScheme: schemeOverride ?? "per-host",
          upstreamSchemeDefault: DEFAULT_UPSTREAM_SCHEME,
          requireToken,
        }),
      );
      return;
    }

    // The kill switch is checked per request, so engaging it takes effect
    // without restarting anything (`skeletonkey disable --all`).
    const kill = killSwitchState(home);
    if (kill.engaged) {
      log(`! refused ${req.method ?? "GET"} ${req.url ?? "/"}: kill switch engaged`);
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "kill_switch",
          engaged_at: kill.at,
          reason: kill.reason,
          hint:
            "The SkeletonKey kill switch is engaged, so no request is forwarded and no key is " +
            "injected. A human clears it with `skeletonkey resume`.",
        }),
      );
      return;
    }

    if (requireToken && !tokenMatches(req.headers["x-skeletonkey-token"], token)) {
      log(`! rejected ${req.method ?? "GET"} ${req.url ?? "/"}: bad or missing X-SkeletonKey-Token`);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "unauthorized",
          hint: "Send the shared gateway token as the X-SkeletonKey-Token header.",
        }),
      );
      return;
    }

    const keys = readKeys(home).keys;
    const target = resolveTarget(req.url ?? "/", (host) =>
      upstreamSchemeFor(host, matchKeyForHost(keys, host), schemeOverride),
    );
    if (!target) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "bad_request",
          hint: "Use an absolute URI (forward proxy) or /<domain>/<path> (reverse mode).",
        }),
      );
      return;
    }

    const targetUrl = target.url;
    const domain = normalizeDomain(targetUrl.host);
    const matched = matchKeyForHost(keys, domain);

    // A disabled key is a decision, not an accident: answer it here rather than
    // forwarding a request the vendor can only reject as an anonymous 401.
    // Nothing leaves this machine, and nothing is charged.
    if (matched?.disabled === true) {
      log(`! refused ${req.method ?? "GET"} ${domain}: key ${matched.alias} is disabled`);
      // Drain the body nobody is going to forward, so a keep-alive connection
      // is not left half-read.
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "key_disabled",
          alias: matched.alias,
          domain: matched.domain,
          hint:
            `The key ${matched.alias} for ${matched.domain} is disabled, so SkeletonKey did not ` +
            `inject it and did not forward this request. A human can re-enable it with ` +
            `\`skeletonkey enable ${matched.alias}\`.`,
        }),
      );
      ledger.record({
        alias: matched.alias,
        domain,
        timestamp: new Date().toISOString(),
        status: 403,
        bytes: 0,
        cost: null,
      });
      return;
    }

    const key = matched;
    const headers = sanitizeHeaders(req.headers, key);
    headers["host"] = targetUrl.host;

    let injected = false;
    if (key) {
      const secret = await secretFor(key.alias);
      if (secret === null) {
        log(`! no secret in vault for alias=${key.alias}; forwarding without header`);
      } else {
        headers[key.header.toLowerCase()] = key.format.replace("{key}", secret);
        injected = true;
      }
    }

    const transport = targetUrl.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
      },
      (upstreamRes) => {
        let bytes = 0;
        const responseHeaders = stripHopByHop(upstreamRes.headers);
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => {
          finish(upstreamRes.statusCode ?? null, bytes, costFrom(upstreamRes.headers));
        });
      },
    );

    upstream.on("error", (error) => {
      log(`! upstream ${domain} failed: ${describe(error)}`);
      finish(null, 0, null);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "upstream_unreachable" }));
    });

    req.pipe(upstream);

    let finished = false;
    function finish(status: number | null, bytes: number, cost: number | null): void {
      if (finished) return;
      finished = true;
      const timestamp = new Date().toISOString();
      ledger.record({ alias: key?.alias ?? null, domain, timestamp, status, bytes, cost });
      if (key) touchLastUsed(key.alias, timestamp, home);
      log(
        `${req.method ?? "GET"} ${domain}${targetUrl.pathname} -> ${status ?? "ERR"} ` +
          `${bytes}b alias=${key?.alias ?? "-"} header=${injected ? key?.header : "none"}`,
      );
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    host,
    url: `http://${formatHost(host)}:${address.port}`,
    requireToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          if (ownLedger) ledger.close();
          secretCache.clear();
          redactor.forget();
          resolve();
        });
      }),
  };
}

/**
 * Forward-proxy requests arrive with an absolute URI; reverse-mode requests
 * arrive as `/<domain>/<path>`.
 */
export function resolveTarget(
  rawUrl: string,
  /** The reverse-mode scheme, or a function that picks one per hostname. */
  upstreamScheme: UpstreamScheme | ((host: string) => UpstreamScheme),
): Target | null {
  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      return { url: new URL(rawUrl), mode: "forward" };
    } catch {
      return null;
    }
  }
  if (!rawUrl.startsWith("/")) return null;
  const withoutLeadingSlash = rawUrl.slice(1);
  if (withoutLeadingSlash === "") return null;
  const slash = withoutLeadingSlash.indexOf("/");
  const hostPart = slash === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slash);
  const rest = slash === -1 ? "/" : withoutLeadingSlash.slice(slash);
  const [hostOnly] = hostPart.split("?");
  let host: string;
  try {
    host = decodeURIComponent(hostOnly ?? "");
  } catch {
    host = hostOnly ?? "";
  }
  if (!host || !/^[a-z0-9.\-:[\]]+$/i.test(host)) return null;
  const query = slash === -1 && hostPart.includes("?") ? hostPart.slice(hostPart.indexOf("?")) : "";
  const scheme =
    typeof upstreamScheme === "function" ? upstreamScheme(normalizeDomain(host)) : upstreamScheme;
  try {
    return { url: new URL(`${scheme}://${host}${rest}${query}`), mode: "reverse" };
  } catch {
    return null;
  }
}

/** What an upstream gets when nobody says otherwise. A key is at stake. */
export const DEFAULT_UPSTREAM_SCHEME: UpstreamScheme = "https";

/**
 * `localhost`, `127.0.0.0/8`, and `::1` never leave the machine, so plain HTTP
 * to one of them discloses nothing -- and a local test server speaking https is
 * the rare case, not the common one.
 */
export function isLoopbackHost(host: string): boolean {
  const value = normalizeDomain(host).replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (/^127(\.\d{1,3}){3}$/.test(value)) return true;
  return false;
}

/**
 * The scheme one upstream is reached over, most specific rule first:
 *
 *   1. the key's own `scheme`, set per key with `skeletonkey add --scheme http`;
 *   2. the global `--upstream-scheme` override, when one was passed;
 *   3. http for a loopback host;
 *   4. https.
 */
export function upstreamSchemeFor(
  host: string,
  key: KeyMeta | undefined,
  override: UpstreamScheme | null = null,
): UpstreamScheme {
  if (key?.scheme !== undefined) return key.scheme;
  if (override !== null) return override;
  if (isLoopbackHost(host)) return "http";
  return DEFAULT_UPSTREAM_SCHEME;
}

/**
 * Longest (most specific) *enabled* domain match wins: the key that would
 * actually be injected. The request path uses `matchKeyForHost` instead, so a
 * disabled key can be reported rather than silently skipped.
 */
export function matchKey(keys: KeyMeta[], host: string): KeyMeta | undefined {
  return keys
    .filter((key) => !key.disabled && domainMatches(key.domain, host))
    .sort((a, b) => normalizeDomain(b.domain).length - normalizeDomain(a.domain).length)[0];
}

/**
 * The key that OWNS a host, disabled or not: the proxy has to know that a
 * disabled key exists so it can say so, instead of forwarding a request that
 * the vendor would reject as anonymous. Longest domain wins; on a tie an
 * enabled key beats a disabled one.
 */
export function matchKeyForHost(keys: KeyMeta[], host: string): KeyMeta | undefined {
  return keys
    .filter((key) => domainMatches(key.domain, host))
    .sort(
      (a, b) =>
        normalizeDomain(b.domain).length - normalizeDomain(a.domain).length ||
        Number(a.disabled) - Number(b.disabled),
    )[0];
}

function sanitizeHeaders(
  incoming: http.IncomingHttpHeaders,
  key: KeyMeta | undefined,
): http.OutgoingHttpHeaders {
  const drop = new Set([...HOP_BY_HOP, ...CLIENT_AUTH_HEADERS]);
  if (key) drop.add(key.header.toLowerCase());
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (drop.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

function stripHopByHop(incoming: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.includes(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/** Constant-time comparison so a wrong token leaks nothing about the right one. */
export function tokenMatches(
  provided: string | string[] | undefined,
  expected: string | null,
): boolean {
  if (expected === null || expected === "") return false;
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== "string" || value === "") return false;
  const a = Buffer.from(value, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Wraps a bare IPv6 address in brackets so it can go in a URL. */
export function formatHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function costFrom(headers: http.IncomingHttpHeaders): number | null {
  for (const name of COST_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
