import http from "node:http";
import type { AddressInfo } from "node:net";

export interface EchoServer {
  port: number;
  host: string;
  /** Every request the echo server has seen, including its headers. */
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

/**
 * Minimal upstream used by the tests: echoes back the request headers it
 * received so we can assert on what the proxy injected or stripped.
 */
export async function startEchoServer(options: { cost?: number } = {}): Promise<EchoServer> {
  const requests: EchoServer["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const body = JSON.stringify({
      ok: true,
      method: req.method,
      url: req.url,
      headers: req.headers,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    };
    if (options.cost !== undefined) headers["x-skeletonkey-cost-usd"] = String(options.cost);
    res.writeHead(200, headers);
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    host: "127.0.0.1",
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
