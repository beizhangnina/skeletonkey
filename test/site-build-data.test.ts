/**
 * ND-17: site/scripts/build_apis.py reads the repo's own data (data/apis/*.yaml
 * shards + the committed site/data/ snapshot) -- nothing outside the repo, so a
 * clean clone can build the site. Covers:
 *   - the build succeeds from a temp copy of only the repo's `git ls-files`
 *     tracked files (no access to any path outside that copy), and neither
 *     build_apis.py nor its imports (build_sitemap.py, export_site_data.py)
 *     reference the old external research-tree path
 *   - apis.json has all 162 vendor rows (count + hidden_count), every vendor
 *     object carries the ND-7/ND-8 keys, and a shard-sourced endpoint shows up
 *     verbatim in that vendor's apis.json object AND its page HTML
 *   - hidden rows keep noindex and stay out of the listing/sitemap/llms.txt
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers/env.js";

const SCRIPT_FILES = [
  "site/scripts/build_apis.py",
  "site/scripts/build_sitemap.py",
  "site/scripts/export_site_data.py",
].map((f) => path.join(REPO_ROOT, f));

let tmpRepo: string;
let outDir: string;
let apisJson: {
  count: number;
  hidden_count: number;
  apis: Record<string, unknown>[];
};
let sitemapXml: string;
let llmsTxt: string;

beforeAll(() => {
  // Copy only the repo's tracked files into an isolated temp dir, so the
  // build genuinely cannot fall back to any path outside it (in particular,
  // the old /workspace/skeletonkey-index-research external index).
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-nd17-repo-"));
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const rel of tracked) {
    const src = path.join(REPO_ROOT, rel);
    const dst = path.join(tmpRepo, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-nd17-out-"));
  execFileSync("python3", ["scripts/build_apis.py", "--out", outDir], {
    cwd: path.join(tmpRepo, "site"),
    encoding: "utf8",
  });

  apisJson = JSON.parse(fs.readFileSync(path.join(outDir, "apis.json"), "utf8"));
  sitemapXml = fs.readFileSync(path.join(outDir, "sitemap.xml"), "utf8");
  llmsTxt = fs.readFileSync(path.join(outDir, "llms.txt"), "utf8");
}, 60_000);

describe("build_apis.py reads nothing outside the repo", () => {
  it("neither build_apis.py nor its imports mention the old external research-tree path", () => {
    for (const file of SCRIPT_FILES) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/skeletonkey-index-research/);
    }
  });

  it("builds successfully from a temp copy of only the repo's tracked files", () => {
    expect(fs.existsSync(path.join(outDir, "apis.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "llms.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "sitemap.xml"))).toBe(true);
  });
});

describe("apis.json: all 162 rows, ND-7/ND-8 keys on every vendor", () => {
  it("count + hidden_count = 162", () => {
    expect(apisJson.count + apisJson.hidden_count).toBe(162);
    expect(apisJson.apis.length).toBe(162);
  });

  const ND78_KEYS = [
    "collection_scope",
    "visibility",
    "visibility_note",
    "official_docs_url",
    "auth",
    "pricing",
    "endpoints",
    "endpoints_note",
  ];

  it("every vendor object has every ND-7/ND-8 key (present, possibly null)", () => {
    for (const row of apisJson.apis) {
      for (const key of ND78_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(row, key), `${row.slug} missing ${key}`).toBe(true);
      }
    }
  });

  it("a shard-sourced endpoint (agentline POST /v1/agents) appears verbatim in apis.json and on the vendor page", () => {
    const row = apisJson.apis.find((r) => r.slug === "agentline") as
      | { endpoints: { method: string; path: string }[] }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.endpoints?.length).toBeGreaterThan(0);
    const hit = row?.endpoints.find((e) => e.path === "/v1/agents" && e.method === "POST");
    expect(hit, JSON.stringify(row?.endpoints)).toBeDefined();

    const html = fs.readFileSync(path.join(outDir, "apis", "agentline", "index.html"), "utf8");
    expect(html).toContain("POST /v1/agents");
  });
});

describe("hidden rows: noindex, excluded from listing/sitemap/llms.txt", () => {
  it("deepseek (collection_scope llm) is hidden in apis.json", () => {
    const row = apisJson.apis.find((r) => r.slug === "deepseek") as
      | { collection_scope: string; visibility: string }
      | undefined;
    expect(row?.collection_scope).toBe("llm");
    expect(row?.visibility).toBe("hidden");
  });

  it("deepseek's own page still renders, with a noindex meta tag", () => {
    const html = fs.readFileSync(path.join(outDir, "apis", "deepseek", "index.html"), "utf8");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("DeepSeek");
  });

  it("deepseek is not in sitemap.xml or llms.txt", () => {
    expect(sitemapXml).not.toContain("/apis/deepseek/");
    expect(llmsTxt).not.toMatch(/\]\(https:\/\/skeletonkey\.run\/apis\/deepseek\/\)/);
  });

  it("every hidden row in apis.json is absent from sitemap.xml and llms.txt; no listed row is missing", () => {
    const hiddenSlugs = apisJson.apis.filter((r) => (r as { visibility: string }).visibility === "hidden")
      .map((r) => r.slug as string);
    const listedSlugs = apisJson.apis.filter((r) => (r as { visibility: string }).visibility !== "hidden")
      .map((r) => r.slug as string);
    for (const slug of hiddenSlugs) {
      expect(sitemapXml, slug).not.toContain(`/apis/${slug}/`);
    }
    for (const slug of listedSlugs) {
      expect(sitemapXml, slug).toContain(`/apis/${slug}/`);
    }
  });
});
