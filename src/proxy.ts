import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { readConfig } from "./config.js";
import { domainMatches, normalizeDomain, readKeys, touchLastUsed } from "./keys.js";
import { Ledger, openLedger } from "./ledger.js";
import { skeletonKeyHome } from "./paths.js";
import type { KeyMeta } from "./types.js";
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
  /** Scheme used for reverse-mode (`/<domain>/<path>`) requests. */
  upstreamScheme?: "http" | "https";
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
  const upstreamScheme = options.upstreamScheme ?? "https";
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

  /** Replaces any secret this process has seen with a placeholder. */
  const log = (line: string): void => {
    let safe = line;
    for (const secret of secretCache.values()) {
      if (secret.length >= 4) safe = safe.split(secret).join("[redacted]");
    }
    (options.logger ?? ((text: string) => console.log(text)))(safe);
  };

  const secretFor = async (alias: string): Promise<string | null> => {
    const cached = secretCache.get(alias);
    if (cached !== undefined) return cached;
    const secret = await vault.get(alias);
    if (secret === null) return null;
    secretCache.set(alias, secret);
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
      res.end(JSON.stringify({ ok: true, upstreamScheme, requireToken }));
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

    const target = resolveTarget(req.url ?? "/", upstreamScheme);
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
    const key = matchKey(readKeys(home).keys, domain);
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
  upstreamScheme: "http" | "https",
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
  try {
    return { url: new URL(`${upstreamScheme}://${host}${rest}${query}`), mode: "reverse" };
  } catch {
    return null;
  }
}

/** Longest (most specific) enabled domain match wins. */
export function matchKey(keys: KeyMeta[], host: string): KeyMeta | undefined {
  return keys
    .filter((key) => !key.disabled && domainMatches(key.domain, host))
    .sort((a, b) => normalizeDomain(b.domain).length - normalizeDomain(a.domain).length)[0];
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
