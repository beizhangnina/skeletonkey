/**
 * Capability matching for `find_api` / `request_access`.
 *
 * The first version matched substrings, which is how "zzz-vendor-not-in-any-index"
 * came back with 41 providers: `any` is a substring of `comp-any-`. It also had no
 * notion of a word that carries no signal, so "CVE lookup" matched every row whose
 * prose happened to contain "lookup".
 *
 * This version matches WHOLE WORDS only, drops the words every query shares
 * ("api", "data", "search", "lookup", "the"), and scores what is left by where it
 * matched: a hit on the vendor's name or API domain is strong evidence, a hit on a
 * short capability tag is good evidence, and a hit inside a prose description is
 * weak evidence. A row has to clear a threshold to be returned at all, so a
 * nonsense query returns nothing instead of a third of the index.
 */
import type { ApiEntry } from "./apis.js";

/**
 * Words dropped from both the query and the row before matching: either English
 * glue, or words so common in an API index ("api", "data", "platform") that
 * matching on them says nothing about whether this row fits.
 */
export const CAPABILITY_STOPWORDS: ReadonlySet<string> = new Set([
  // English glue
  "a", "about", "all", "an", "and", "any", "anything", "are", "as", "at", "be", "best", "both",
  "but", "by", "can", "do", "does", "for", "from", "get", "give", "good", "has", "have", "how",
  "i", "if", "in", "into", "is", "it", "its", "just", "like", "me", "my", "need", "needs", "new",
  "no", "none", "not", "nothing", "of", "on", "one", "or", "our", "out", "over", "please",
  "simple", "some", "something", "such", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those",
  "to", "up", "use", "used", "using", "via", "want", "wants", "was", "we", "what", "when", "where",
  "which", "who", "why", "will", "with", "without", "you", "your",
  // Words every second row in an API index contains
  "access", "api", "available", "call", "cheap", "cheapest", "client", "credit", "data", "dataset",
  "detail", "endpoint", "example", "fast", "feed", "field", "free", "index", "info", "information",
  "integration", "interface", "key", "library", "list", "lookup", "offer", "online", "paid",
  "plan", "platform", "price", "pricing", "product", "provider", "query", "rate", "record",
  "request", "response", "result", "return", "sdk", "search", "server", "service", "set", "site",
  "solution", "source", "stuff", "thing", "tool", "vendor", "version",
]);

/** Suffixes of a hostname that identify the registry, not the vendor. */
const HOST_NOISE: ReadonlySet<string> = new Set([
  "ai", "app", "cloud", "co", "com", "dev", "edu", "gov", "io", "net", "org", "sh", "tech", "uk",
  "us", "www", "xyz",
]);

/** Evidence weights, strongest first. See the module comment. */
export const MATCH_WEIGHTS = {
  /** The row's own name, e.g. `builtwith`. */
  name: 3,
  /** The API hostname a key would be registered against. */
  domain: 3,
  /** A short capability tag, e.g. `web scraping`. */
  tag: 2,
  /** A word inside a prose description or a billing unit. */
  prose: 1,
  /** Added when the whole query is exactly a tag or the row's name. */
  phrase: 2,
} as const;

/** A capability string counts as a tag (not prose) up to this many words. */
const TAG_MAX_WORDS = 4;

/**
 * Crude, deliberately symmetric stemmer: it is applied to the query and to the
 * row, so it only has to make the two agree ("scrape"/"scraping", "tweet"/"tweets"),
 * never to produce a real English root.
 */
export function stemWord(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  while (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Whole words of a string, stemmed. Keeps `b2b` and `s3`; drops single letters. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((word) => word.length >= 2)
    .map(stemWord)
    .filter((word) => word.length >= 2);
}

function isStopword(token: string): boolean {
  return CAPABILITY_STOPWORDS.has(token) || CAPABILITY_STOPWORDS.has(stemWord(token));
}

/** Tokens worth matching on, plus the ones dropped, so a tool can say why. */
export function queryTokens(capability: string): { tokens: string[]; ignored: string[] } {
  const tokens: string[] = [];
  const ignored: string[] = [];
  for (const raw of capability.toLowerCase().split(/[^a-z0-9+]+/)) {
    if (raw.length < 2) {
      if (raw !== "") ignored.push(raw);
      continue;
    }
    const token = stemWord(raw);
    if (isStopword(raw) || isStopword(token)) {
      ignored.push(raw);
      continue;
    }
    if (!tokens.includes(token)) tokens.push(token);
  }
  return { tokens, ignored };
}

interface EntryTokens {
  /** Token -> the strongest evidence weight it carries for this row. */
  weights: Map<string, number>;
  /** Whole stemmed phrases (the name, each tag), for the exact-phrase bonus. */
  phrases: Set<string>;
}

const entryTokenCache = new WeakMap<object, EntryTokens>();

function addTokens(weights: Map<string, number>, tokens: string[], weight: number): void {
  for (const token of tokens) {
    if (isStopword(token)) continue;
    const current = weights.get(token);
    if (current === undefined || current < weight) weights.set(token, weight);
  }
}

function hostTokens(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value.trim() === "") return [];
  let host = value.trim();
  const match = /^[a-z0-9+.-]+:\/\/([^/?#]+)/i.exec(host);
  if (match?.[1] !== undefined) host = match[1];
  return tokenize(host.split("/")[0] ?? "").filter((token) => !HOST_NOISE.has(token));
}

/** Builds (and caches) the weighted word list for one index row. */
export function entryTokens(entry: ApiEntry): EntryTokens {
  const cached = entryTokenCache.get(entry as unknown as object);
  if (cached !== undefined) return cached;

  const weights = new Map<string, number>();
  const phrases = new Set<string>();

  const nameTokens = tokenize(entry.name);
  addTokens(weights, nameTokens, MATCH_WEIGHTS.name);
  if (nameTokens.length > 0) phrases.add(nameTokens.join(" "));

  addTokens(weights, hostTokens(entry.domain), MATCH_WEIGHTS.domain);
  addTokens(weights, hostTokens(entry.base_url), MATCH_WEIGHTS.domain);

  for (const capability of entry.capabilities ?? []) {
    const words = capability.trim().split(/\s+/).filter((word) => word !== "");
    const tokens = tokenize(capability);
    if (words.length <= TAG_MAX_WORDS) {
      addTokens(weights, tokens, MATCH_WEIGHTS.tag);
      if (tokens.length > 0) phrases.add(tokens.join(" "));
    } else {
      addTokens(weights, tokens, MATCH_WEIGHTS.prose);
    }
  }

  if (entry.billing_unit !== null && entry.billing_unit !== undefined) {
    addTokens(weights, tokenize(entry.billing_unit), MATCH_WEIGHTS.prose);
  }

  const built: EntryTokens = { weights, phrases };
  entryTokenCache.set(entry as unknown as object, built);
  return built;
}

export interface CapabilityScore {
  /** Summed evidence. 0 means nothing matched. */
  score: number;
  /** Query tokens this row matched, and the ones it did not. */
  matched: string[];
  missing: string[];
  /** The tokens the query was reduced to, and the words dropped as generic. */
  tokens: string[];
  ignored: string[];
  /** The strongest single piece of evidence: 3 = name or domain, 1 = prose. */
  best_weight: number;
  /** True when the row clears the threshold `find_api` filters on. */
  matches: boolean;
}

/**
 * Scores one row against a free-text capability.
 *
 * A row is returned when it matched at least half of the meaningful words in the
 * query, OR when one of the words it matched is the vendor's own name or API
 * domain -- "apollo b2b contact enrichment for sales" should still find Apollo.
 * Everything else, including every word-free nonsense query, scores 0.
 */
export function scoreCapability(entry: ApiEntry, capability: string): CapabilityScore {
  const { tokens, ignored } = queryTokens(capability);
  const empty = capability.trim() === "";
  if (tokens.length === 0) {
    return {
      score: 0,
      matched: [],
      missing: [],
      tokens,
      ignored,
      best_weight: 0,
      // An empty capability is "show me everything"; a query made only of
      // generic words ("any data api") is not, and matches nothing.
      matches: empty,
    };
  }

  const { weights, phrases } = entryTokens(entry);
  const matched: string[] = [];
  const missing: string[] = [];
  let score = 0;
  let best = 0;
  for (const token of tokens) {
    const weight = weights.get(token);
    if (weight === undefined) {
      missing.push(token);
      continue;
    }
    matched.push(token);
    score += weight;
    if (weight > best) best = weight;
  }

  if (matched.length > 0 && phrases.has(tokens.join(" "))) score += MATCH_WEIGHTS.phrase;

  const coverage = matched.length / tokens.length;
  const matches = matched.length > 0 && (coverage >= 0.5 || best >= MATCH_WEIGHTS.name);
  return { score, matched, missing, tokens, ignored, best_weight: best, matches };
}

/**
 * Whether a row answers a free-text capability. An empty capability matches
 * everything; a query of nothing but generic words matches nothing.
 */
export function matchesCapability(entry: ApiEntry, capability: string): boolean {
  return scoreCapability(entry, capability).matches;
}

/**
 * The rows that match, best evidence first. Ties keep index order, which puts
 * the hand-written `apis.yaml` rows (the ones that know the auth header) ahead
 * of generated shard rows.
 */
export function rankByCapability<T extends ApiEntry>(
  entries: readonly T[],
  capability: string,
): { entry: T; score: CapabilityScore }[] {
  return entries
    .map((entry, position) => ({ entry, position, score: scoreCapability(entry, capability) }))
    .filter((row) => row.score.matches)
    .sort((a, b) => b.score.score - a.score.score || a.position - b.position)
    .map(({ entry, score }) => ({ entry, score }));
}
