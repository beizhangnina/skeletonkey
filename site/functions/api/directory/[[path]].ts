/**
 * GET /api/directory/* — forwards to the index server's /v1/*.
 *
 * Why this exists: the index server answers without an
 * `Access-Control-Allow-Origin` header, so the landing page at `/directory/`
 * cannot read it cross-origin from a browser at all. Forwarding through this
 * site makes the call same-origin while leaving the server's contract alone —
 * the path, the query string, the status and the body all pass through as they
 * came, and nothing here reinterprets a payload.
 *
 * Read-only by design. Only the index endpoints the landing page actually uses
 * are forwarded. `/v1/telemetry/batch` is a POST — data flowing *out* — and is
 * not reachable here; `/v1/index/bundle/*` is megabytes meant for the CLI and
 * is not either.
 */

/**
 * ── T7a swap point ─────────────────────────────────────────────────────────
 * The deployed index server: origin only, no trailing slash, no path. This is
 * the single place that URL appears anywhere in the frontend.
 *
 * Today it is the staging preview T7a stood up on workers.dev. The production
 * environment has no route or custom domain attached yet, so there is nothing
 * else to point at. Replacing this one line is the whole of the production
 * cutover for this page.
 */
const INDEX_SERVER_URL = "https://skeletonkey-index-server.beizhangbill.workers.dev";

/** Index paths that may be forwarded, relative to `/v1/`. */
const FORWARDABLE: RegExp[] = [
  /^health$/,
  /^index\/manifest$/,
  /^index\/search$/,
  /^index\/vendors$/,
  /^index\/vendors\/[A-Za-z0-9._-]{1,64}$/,
];

/** Response headers worth carrying over: they let the edge cache the answer. */
const PASS_THROUGH = ["Content-Type", "Cache-Control", "ETag"];

function error(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const onRequestGet: PagesFunction = async ({ params, request }) => {
  const raw = params.path;
  const path = (Array.isArray(raw) ? raw : [raw ?? ""]).filter((s) => s !== "").join("/");

  if (!FORWARDABLE.some((allowed) => allowed.test(path))) {
    return error(404, { error: "not_forwarded", path });
  }

  const target = new URL(`${INDEX_SERVER_URL}/v1/${path}`);
  target.search = new URL(request.url).search;

  let upstream: Response;
  try {
    // A fresh request, not a copy: none of the visitor's headers — cookies, or
    // anything identifying — are carried upstream.
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return error(502, { error: "index_unreachable" });
  }

  const headers = new Headers({ "X-Content-Type-Options": "nosniff" });
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
};

/** Anything other than GET never reaches the index server through this route. */
export const onRequest: PagesFunction = async () =>
  error(405, { error: "method_not_allowed" });
