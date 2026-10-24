import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readKeys } from "../src/keys.js";
import { openLedger } from "../src/ledger.js";
import { matchKey, resolveTarget, startProxy, type ProxyHandle } from "../src/proxy.js";
import { initWithKey, makeHome, removeHome, runCli } from "./helpers/env.js";
import { startEchoServer, type EchoServer } from "./helpers/echo-server.js";

const SECRET = "sk-test-FAKE-proxy-7777";

interface EchoBody {
  headers: Record<string, string>;
  url: string;
  method: string;
}

describe("proxy header injection", () => {
  let home: string;
  let echo: EchoServer;
  let proxy: ProxyHandle;
  let logs: string[];

  beforeEach(async () => {
    home = makeHome();
    logs = [];
    echo = await startEchoServer({ cost: 0.0042 });
    await initWithKey(home, { alias: "echo-key", secret: SECRET, domain: "127.0.0.1" });
    proxy = await startProxy({
      port: 0,
      home,
      upstreamScheme: "http",
      logger: (line) => logs.push(line),
    });
  });

  afterEach(async () => {
    await proxy.close();
    await echo.close();
    removeHome(home);
  });

  it("injects the configured header in reverse mode", async () => {
    const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as EchoBody;
    expect(body.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(body.url).toBe("/v1/hello");
  });

  it("forwards query strings and request bodies", async () => {
    const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/items?q=a%20b&n=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const body = (await response.json()) as EchoBody;
    expect(body.method).toBe("POST");
    expect(body.url).toBe("/v1/items?q=a%20b&n=2");
    expect(body.headers["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("works as a forward proxy for absolute-URI requests", async () => {
    // Send a raw absolute-URI request the way an HTTP_PROXY client would.
    const body = await rawProxyRequest(proxy.port, `http://127.0.0.1:${echo.port}/v1/forward`);
    const parsed = JSON.parse(body) as EchoBody;
    expect(parsed.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(parsed.url).toBe("/v1/forward");
  });

  it("strips a client-supplied auth header and replaces it with the vault secret", async () => {
    const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`, {
      headers: { authorization: "Bearer client-supplied-garbage", "x-api-key": "also-garbage" },
    });
    const body = (await response.json()) as EchoBody;
    expect(body.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(body.headers["x-api-key"]).toBeUndefined();
  });

  it("does not inject for a disabled key", async () => {
    await runCli(home, ["disable", "echo-key"]);
    const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`, {
      headers: { authorization: "Bearer client-supplied-garbage" },
    });
    const body = (await response.json()) as EchoBody;
    expect(body.headers["authorization"]).toBeUndefined();
  });

  it("does not inject for an unrelated domain", async () => {
    const response = await fetch(`${proxy.url}/localhost:${echo.port}/v1/hello`);
    const body = (await response.json()) as EchoBody;
    expect(body.headers["authorization"]).toBeUndefined();
  });

  it("refuses CONNECT, which cannot be injected into", async () => {
    const status = await rawConnect(proxy.port, `127.0.0.1:${echo.port}`);
    expect(status).toContain("405");
  });

  it("never writes a secret to the log", async () => {
    await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(SECRET);
    expect(logs.join("\n")).toContain("alias=echo-key");
  });

  it("writes one ledger row per call and updates last_used", async () => {
    await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/one`);
    await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/two`);

    const ledger = openLedger(home);
    const rows = ledger.all();
    ledger.close();

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.alias).toBe("echo-key");
      expect(row.domain).toBe("127.0.0.1");
      expect(row.status).toBe(200);
      expect(row.bytes).toBeGreaterThan(0);
      expect(row.cost).toBeCloseTo(0.0042);
      expect(Number.isNaN(Date.parse(row.timestamp))).toBe(false);
    }

    expect(readKeys(home).keys[0]?.last_used).not.toBeNull();

    const printed = await runCli(home, ["ledger", "--limit", "5"]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain("echo-key");
    expect(printed.stdout).not.toContain(SECRET);
  });

  it("records a row with a null cost when the upstream reports no price", async () => {
    const plain = await startEchoServer();
    try {
      await fetch(`${proxy.url}/127.0.0.1:${plain.port}/v1/hello`);
      const ledger = openLedger(home);
      const rows = ledger.all();
      ledger.close();
      expect(rows.at(-1)?.cost).toBeNull();
    } finally {
      await plain.close();
    }
  });

  it("logs a row even when the upstream is unreachable", async () => {
    const dead = await startEchoServer();
    const deadPort = dead.port;
    await dead.close();
    const response = await fetch(`${proxy.url}/127.0.0.1:${deadPort}/v1/hello`);
    expect(response.status).toBe(502);

    const ledger = openLedger(home);
    const rows = ledger.all();
    ledger.close();
    expect(rows.at(-1)?.status).toBeNull();
  });

  it("rejects requests that name no destination", async () => {
    const response = await fetch(`${proxy.url}/`);
    expect(response.status).toBe(400);
  });
});

describe("target resolution", () => {
  it("parses absolute URIs as forward-proxy requests", () => {
    const target = resolveTarget("http://api.example.com/v1/x?y=1", "https");
    expect(target?.mode).toBe("forward");
    expect(target?.url.host).toBe("api.example.com");
    expect(target?.url.pathname).toBe("/v1/x");
  });

  it("parses /<domain>/<path> using the configured upstream scheme", () => {
    expect(resolveTarget("/api.example.com/v1/x", "https")?.url.href).toBe(
      "https://api.example.com/v1/x",
    );
    expect(resolveTarget("/api.example.com/v1/x", "http")?.url.href).toBe(
      "http://api.example.com/v1/x",
    );
    expect(resolveTarget("/api.example.com", "https")?.url.href).toBe("https://api.example.com/");
  });

  it("rejects junk", () => {
    expect(resolveTarget("/", "https")).toBeNull();
    expect(resolveTarget("not-a-path", "https")).toBeNull();
    expect(resolveTarget("/bad host/x", "https")).toBeNull();
  });
});

describe("key matching", () => {
  const base = {
    platform: "x",
    header: "Authorization",
    format: "Bearer {key}",
    created: "2026-01-01T00:00:00.000Z",
    last_used: null,
    disabled: false,
  };

  it("prefers the most specific enabled domain", () => {
    const keys = [
      { ...base, alias: "wide", domain: "example.com" },
      { ...base, alias: "narrow", domain: "api.example.com" },
    ];
    expect(matchKey(keys, "api.example.com")?.alias).toBe("narrow");
    expect(matchKey(keys, "other.example.com")?.alias).toBe("wide");
  });

  it("skips disabled keys", () => {
    const keys = [{ ...base, alias: "off", domain: "example.com", disabled: true }];
    expect(matchKey(keys, "example.com")).toBeUndefined();
  });
});

/** Issues an HTTP/1.1 request with an absolute request-target, as a proxy client does. */
async function rawProxyRequest(port: number, absoluteUri: string): Promise<string> {
  const net = await import("node:net");
  const url = new URL(absoluteUri);
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${absoluteUri} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
      );
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (raw += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const index = raw.indexOf("\r\n\r\n");
      resolve(index === -1 ? raw : raw.slice(index + 4));
    });
  });
}

async function rawConnect(port: number, authority: string): Promise<string> {
  const net = await import("node:net");
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (raw += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(raw));
  });
}

describe("gateway mode token", () => {
  let home: string;
  let echo: EchoServer;
  let proxy: ProxyHandle;

  const TOKEN = "gateway-token-FAKE-abc123";

  beforeEach(async () => {
    home = makeHome();
    echo = await startEchoServer();
    await initWithKey(home, { alias: "echo-key", secret: SECRET, domain: "127.0.0.1" });
    proxy = await startProxy({
      port: 0,
      home,
      upstreamScheme: "http",
      token: TOKEN,
      requireToken: true,
      logger: () => {},
    });
  });

  afterEach(async () => {
    await proxy.close();
    await echo.close();
    removeHome(home);
  });

  it("rejects a request with no token", async () => {
    const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(response.status).toBe(401);
    expect(echo.requests).toHaveLength(0);
  });

  it("rejects a wrong token, including a prefix of the right one", async () => {
    for (const bad of ["nope", TOKEN.slice(0, -1), `${TOKEN}x`, ""]) {
      const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`, {
        headers: { "x-skeletonkey-token": bad },
      });
      expect(response.status, JSON.stringify(bad)).toBe(401);
    }
    expect(echo.requests).toHaveLength(0);
  });

  it("accepts the right token, injects the key, and does not forward the token", async () => {
    const response = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`, {
      headers: { "x-skeletonkey-token": TOKEN },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as EchoBody;
    expect(body.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    // The gateway token authenticates the caller to us; upstream must not see it.
    expect(body.headers["x-skeletonkey-token"]).toBeUndefined();
  });

  it("leaves /__skeletonkey/health reachable so other devices can wait for it", async () => {
    const response = await fetch(`${proxy.url}/__skeletonkey/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; requireToken: boolean };
    expect(body).toMatchObject({ ok: true, requireToken: true });
  });

  it("refuses to start in token-required mode with no token", async () => {
    await expect(
      startProxy({ port: 0, home, requireToken: true, token: null, logger: () => {} }),
    ).rejects.toThrow(/no token was supplied/);
  });
});
