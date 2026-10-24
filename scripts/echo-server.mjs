#!/usr/bin/env node
// Tiny upstream for the demo: echoes back whatever headers it received.
// Usage: node scripts/echo-server.mjs [port]   (0 or omitted = pick a free port)
import http from "node:http";

const requested = Number(process.argv[2] ?? 0);

const server = http.createServer((req, res) => {
  const body = JSON.stringify(
    { ok: true, method: req.method, url: req.url, headers: req.headers },
    null,
    2,
  );
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    // Pretend the upstream reports a per-call price, so the ledger has a cost.
    "x-skeletonkey-cost-usd": "0.0012",
  });
  res.end(body);
});

server.listen(Number.isFinite(requested) ? requested : 0, "127.0.0.1", () => {
  console.log(`PORT=${server.address().port}`);
});
