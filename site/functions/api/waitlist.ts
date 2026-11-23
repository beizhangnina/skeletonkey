/**
 * POST /api/waitlist — stores a hosted MCP waitlist address in KV.
 *
 * Privacy notes: the client IP is never stored, only a SHA-256 hash of it,
 * and only as a short lived rate limit counter that expires after an hour.
 */

interface Env {
  WAITLIST: KVNamespace;
}

interface Entry {
  email: string;
  createdAt: string;
  source: "landing";
}

interface Counter {
  n: number;
  exp: number; // unix seconds when this window ends
}

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 5;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readFields(request: Request): Promise<Record<string, string>> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const fields: Record<string, string> = {};

  if (type.includes("application/json")) {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") fields[key] = value;
      }
    }
    return fields;
  }

  if (
    type.includes("application/x-www-form-urlencoded") ||
    type.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    return fields;
  }

  // No usable content type: try form encoding on the raw text.
  const text = await request.text();
  for (const [key, value] of new URLSearchParams(text).entries()) {
    fields[key] = value;
  }
  return fields;
}

/** Optional same origin guard. Browsers always send Origin on a cross origin POST. */
function originMismatch(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

/** Returns true when this caller has used up the window. */
async function overRateLimit(kv: KVNamespace, ip: string | null): Promise<boolean> {
  if (!ip) return false;

  const key = `rl:${await sha256Hex(ip)}`;
  const now = Math.floor(Date.now() / 1000);
  const stored = await kv.get<Counter>(key, "json");

  const window: Counter =
    stored && typeof stored.n === "number" && typeof stored.exp === "number" && stored.exp > now
      ? stored
      : { n: 0, exp: now + WINDOW_SECONDS };

  if (window.n >= MAX_PER_WINDOW) return true;

  window.n += 1;
  await kv.put(key, JSON.stringify(window), {
    // KV requires at least 60 seconds of TTL.
    expirationTtl: Math.max(60, window.exp - now),
  });
  return false;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.WAITLIST) {
    return json({ ok: false, error: "storage_unavailable" }, 500);
  }
  if (originMismatch(request)) {
    return json({ ok: false, error: "bad_origin" }, 403);
  }

  let fields: Record<string, string>;
  try {
    fields = await readFields(request);
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  // Honeypot: a real person never fills a field they cannot see. Answer as if
  // it worked so a bot learns nothing, and store nothing.
  if ((fields.company ?? "").trim() !== "") {
    return json({ ok: true, status: "ok" });
  }

  const email = (fields.email ?? "").trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  if (await overRateLimit(env.WAITLIST, request.headers.get("CF-Connecting-IP"))) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  const key = `email:${email}`;
  if ((await env.WAITLIST.get(key)) !== null) {
    return json({ ok: true, status: "exists" });
  }

  const entry: Entry = {
    email,
    createdAt: new Date().toISOString(),
    source: "landing",
  };
  await env.WAITLIST.put(key, JSON.stringify(entry));

  return json({ ok: true, status: "added" });
};

/** Every other method on this route. Method specific handlers win over this one. */
export const onRequest: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
    status: 405,
    headers: {
      "content-type": "application/json; charset=utf-8",
      allow: "POST",
      "cache-control": "no-store",
    },
  });
