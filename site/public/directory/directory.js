/**
 * API Directory — reads the index server and renders what it says.
 *
 * Two rules shape this file:
 *
 *   1. `null` means "nobody checked". It never means free, and never means no
 *      key is needed. Every blank is rendered as "not checked" rather than as
 *      an absence of cost or of auth.
 *   2. Every row is untrusted text (the server flags it `untrusted_text: true`
 *      and strips control characters, but the content is still a vendor's
 *      prose). Nothing from a response reaches the page as markup — only ever
 *      as `textContent`.
 */
import { INDEX_BASE } from "./config.js";

/** Capabilities worth a one-click shortcut. The first one loads on arrival. */
const CHIPS = [
  "llm",
  "scraping",
  "email",
  "enrichment",
  "maps",
  "weather",
  "speech",
  "transcription",
];

const LIMIT = 24;

const form = document.getElementById("dr-form");
const input = document.getElementById("dr-q");
const chipBar = document.getElementById("dr-chips");
const status = document.getElementById("dr-status");
const results = document.getElementById("dr-results");
const notice = document.getElementById("dr-notice");

let inFlight = 0;

/* ----------------------------------------------------------- small helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** An http(s) link, or plain text when the value is not one. */
function link(url, label) {
  const text = label ?? url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return el("span", null, text);
  const a = el("a", null, text);
  a.href = url;
  a.rel = "noopener nofollow";
  return a;
}

function unchecked() {
  return el("span", "dr-unchecked", "not checked");
}

/** A `<dt>/<dd>` pair. `value` may be a node, a string, or null for unchecked. */
function row(dl, label, value) {
  dl.append(el("dt", null, label));
  const dd = el("dd");
  if (value === null || value === undefined || value === "") dd.append(unchecked());
  else if (value instanceof Node) dd.append(value);
  else dd.append(document.createTextNode(String(value)));
  dl.append(dd);
}

function code(text) {
  return el("code", null, text);
}

/* ------------------------------------------------------------------ render */

/** "What it does" — the capability tags the index matched on. */
function capabilities(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const ul = el("ul", "dr-caps");
  for (const cap of list.slice(0, 10)) ul.append(el("li", null, cap));
  return ul;
}

/**
 * "What's free" — the vendor's own words, with the verification behind them.
 * `free_tier_covers_api: false` is a fact worth saying out loud: there is a
 * free tier, and it does not reach the API.
 */
function free(match) {
  const billing = match.billing ?? {};
  const frag = document.createDocumentFragment();

  if (billing.free_tier_note) {
    frag.append(el("span", null, billing.free_tier_note));
  } else if (billing.model) {
    frag.append(el("span", null, `Billing model: ${billing.model}. No free-tier note recorded.`));
  } else {
    return null;
  }

  if (billing.free_tier_covers_api === false) {
    frag.append(el("span", null, " "));
    frag.append(el("strong", null, "The free tier does not cover API access."));
  }
  return frag;
}

/** "How to connect" — base URL, the header the key goes in, where to sign up. */
function connect(match) {
  const auth = match.auth ?? {};
  const frag = document.createDocumentFragment();
  const parts = [];

  if (auth.base_url) parts.push(["Base URL", code(auth.base_url)]);

  if (auth.auth_header && auth.auth_format) {
    parts.push(["Auth", code(`${auth.auth_header}: ${auth.auth_format}`)]);
  } else if (auth.auth_header) {
    parts.push(["Auth", code(auth.auth_header)]);
  }

  if (auth.signup_url) parts.push(["Sign up", link(auth.signup_url)]);
  if (auth.requires_card === true) parts.push(["Card", el("span", null, "required to sign up")]);
  if (auth.requires_card === false) parts.push(["Card", el("span", null, "not required")]);

  if (parts.length === 0) return null;

  for (const [label, node] of parts) {
    const line = el("div");
    line.append(el("span", "ap-small", `${label}: `), node);
    frag.append(line);
  }
  return frag;
}

/** Aggregator gateways that already hold a key for this vendor. */
function routes(match) {
  const carried = (match.aggregators ?? []).filter((a) => a && a.carries === true);
  if (carried.length === 0) return null;

  const frag = document.createDocumentFragment();
  carried.forEach((a, i) => {
    if (i > 0) frag.append(document.createTextNode(", "));
    frag.append(el("span", null, a.name));
    if (typeof a.per_call_price_usd === "number") {
      frag.append(document.createTextNode(` ($${a.per_call_price_usd}/call`));
      if (a.price_verified_url) {
        frag.append(document.createTextNode(", "));
        frag.append(link(a.price_verified_url, "priced"));
      }
      frag.append(document.createTextNode(")"));
    } else {
      frag.append(el("span", "dr-unchecked", " (price not checked)"));
    }
  });
  return frag;
}

function provenance(match) {
  const billing = match.billing ?? {};
  const frag = document.createDocumentFragment();
  const date = billing.verified_date ?? match.checked_date;

  if (billing.verified_url && billing.verified_date) {
    frag.append(link(billing.verified_url, `vendor's own page, read ${billing.verified_date}`));
  } else if (date) {
    frag.append(el("span", null, `checked ${date}`));
  } else {
    return null;
  }

  if (match.source) {
    frag.append(document.createTextNode(" · "));
    frag.append(link(match.source, "source"));
  }
  return frag;
}

function card(match) {
  const section = el("article", "ap-card");

  const head = el("div", "dr-head");
  const h2 = el("h2");
  h2.append(link(match.vendor_url ?? match.url, match.name ?? match.id));
  head.append(h2);

  if (match.access_mode) head.append(el("span", "ap-badge", match.access_mode));
  if (match.entry_status) head.append(el("span", "ap-badge", match.entry_status));
  if (match.is_example_row === true) head.append(el("span", "ap-badge", "example row"));
  section.append(head);

  const dl = el("dl", "ap-dl");
  row(dl, "What it does", capabilities(match.capabilities));
  row(dl, "What's free", free(match));
  row(dl, "How to connect", connect(match));

  const carried = routes(match);
  if (carried) row(dl, "Also via", carried);

  const where = provenance(match);
  if (where) row(dl, "Verified", where);

  section.append(dl);
  return section;
}

/* ------------------------------------------------------------------- fetch */

function setChipState(query) {
  for (const button of chipBar.querySelectorAll(".dr-chip")) {
    button.setAttribute("aria-pressed", String(button.dataset.q === query));
  }
}

async function search(query, { push = true } = {}) {
  const q = query.trim();
  setChipState(q);
  if (q === "") {
    results.replaceChildren();
    status.textContent = "Name a capability to search for.";
    return;
  }

  if (push) {
    const url = new URL(window.location.href);
    url.searchParams.set("q", q);
    window.history.replaceState(null, "", url);
  }

  const token = ++inFlight;
  status.textContent = `Searching for “${q}”…`;

  let payload;
  try {
    const response = await fetch(
      `${INDEX_BASE}/index/search?q=${encodeURIComponent(q)}&limit=${LIMIT}`,
      { headers: { Accept: "application/json" } },
    );
    if (response.status === 429) throw new Error("The index server is rate limiting this page. Try again in a minute.");
    if (!response.ok) throw new Error(`The index server answered ${response.status}.`);
    payload = await response.json();
  } catch (err) {
    if (token !== inFlight) return;
    results.replaceChildren();
    status.textContent =
      err instanceof Error && err.message.startsWith("The index server")
        ? err.message
        : "Could not reach the index server.";
    return;
  }

  if (token !== inFlight) return;

  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  const total = typeof payload.match_count === "number" ? payload.match_count : matches.length;
  const ignored = payload.query?.ignored ?? [];

  if (matches.length === 0) {
    results.replaceChildren(
      el(
        "p",
        "dr-empty",
        "Nothing in this snapshot matches that capability. The index answers on what a service does — try the job rather than the vendor, or browse the full index at /apis/.",
      ),
    );
  } else {
    results.replaceChildren(...matches.map(card));
  }

  const shown = matches.length === total ? `${total}` : `${matches.length} of ${total}`;
  const noun = total === 1 ? "API" : "APIs";
  let line = `${shown} ${noun} for “${q}” · snapshot ${payload.snapshot ?? "unknown"}`;
  if (ignored.length > 0) line += ` · ignored: ${ignored.join(", ")}`;
  status.textContent = line;
}

/** The snapshot's own notice — staging says so here, rather than silently. */
async function loadManifest() {
  try {
    const response = await fetch(`${INDEX_BASE}/index/manifest`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const manifest = await response.json();
    const bits = [];
    if (typeof manifest.vendor_count === "number") {
      bits.push(`${manifest.vendor_count} APIs in snapshot ${manifest.snapshot}.`);
    }
    if (manifest.notice) bits.push(manifest.notice);
    if (bits.length === 0) return;
    notice.textContent = bits.join(" ");
    notice.hidden = false;
  } catch {
    /* The notice is a nicety; the search below is the page. */
  }
}

/* -------------------------------------------------------------------- init */

for (const cap of CHIPS) {
  const button = el("button", "dr-chip", cap);
  button.type = "button";
  button.dataset.q = cap;
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    input.value = cap;
    search(cap);
  });
  chipBar.append(button);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search(input.value);
});

const initial = new URL(window.location.href).searchParams.get("q") ?? CHIPS[0];
input.value = initial;
loadManifest();
search(initial, { push: false });
