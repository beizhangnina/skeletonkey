Build a minimal static landing page for SkeletonKey (skeletonkey.run) in this directory. Do NOT deploy, do NOT git push.

READ FIRST: design-sources/landing-page-design-SKILL.md (Elaya's landing-page skill, Part B visual rules: follow its type/spacing/radius/motion tokens where compatible with "extremely minimal") and design-sources/X-GitTrend0x-ai-aesthetic-skills.md (anti-AI-slop: NO purple/blue gradients, NO card-in-card, no Inter+purple default look, no glassmorphism, no emoji icons). Use layout type C "Minimal conversion page". Skip FAQ/testimonials/logo strips (we have no proof; never invent users, metrics, stars, prices).

Product facts (only these; v0.1, MIT, Node 22+, TypeScript):
- Local-first: a vault for your own API keys (Bitwarden default; also 1Password, OS keychain, encrypted file), a loopback proxy on 127.0.0.1 that injects the key by destination domain and logs one SQLite ledger row per call, and an MCP server + skill your agent (Claude Code, Codex) talks to. No tool returns a key. No account, no SkeletonKey server.
- Agent flow: find_api("web scraping") against a local index (163 providers seeded; discover_api/propose_entry adds unknown vendors locally = discover-on-miss) -> request_access gives a proxy URL for a key you hold, or a signup plan the agent walks with its own browser/email; a human confirms payment and terms -> call the API through the proxy; the agent never holds the key.
- Go direct with your own keys instead of signing up for key aggregators; the index recommends an aggregator route only when direct needs a subscription.
- Install (from source, npm publish disabled):
  git clone https://github.com/beizhangnina/skeletonkey.git && cd skeletonkey && npm install && npm run build && npm link
  then: skeletonkey init   (alias skk)
- Repo: https://github.com/beizhangnina/skeletonkey

Deliverables:
1. DESIGN.md: design system. ONE accent color: use a warm brass/amber key color (e.g. #E8B04B-ish on dark, darkened variant for light mode to pass WCAG AA) — justify: physical brass key / unlock, distinct from the purple/blue AI-tool default, terminal-amber dev-tool heritage, reads well on dark. Neutrals (warm-ish grays, near-black bg #0B0B0C-ish, light mode too), type scale (system UI sans + system monospace stack ui-monospace,SFMono-Regular,Menlo; no web fonts), spacing scale (4/8 based), radius, components (button primary/secondary, code block with copy button, card/point, input). Contrast ratios listed. Wordmark spec.
2. assets/logo.svg: text wordmark: monospace "skeletonkey" with a small geometric key glyph (circle bow + shaft + 2 teeth) in accent, using currentColor for text so it works dark/light; also assets/mark.svg (glyph only) and favicon.svg. Convert text to paths is optional; if using <text>, font-family monospace stack.
3. public/index.html (+ public/styles.css inline or separate, tiny vanilla JS for copy button + form). Sections: header (wordmark + GitHub link); hero: one-line English value prop (e.g. "Let your agent get its own API access — with your keys, in your vault."), short subline, install snippet with copy button; "How it works" 3 short points (Find / Get access / Call through the proxy); two paths side by side: "Open source — self-host, free" (GitHub button) and "Hosted MCP — coming soon" with email waitlist form (no price), honeypot hidden field named "company"; footer: MIT license, GitHub. prefers-color-scheme dark+light. Responsive to 360px. Accessible labels, focus states, reduced-motion. Meta description, OG tags, favicon. NO analytics, trackers, external fonts or CDNs. Graceful client messages: success, already-on-list, invalid, rate-limited, network error.
4. functions/api/waitlist.ts: Cloudflare Pages Function onRequestPost (and 405 otherwise). Accept JSON or form-encoded. Validate email (length<=254, regex), lowercase/trim. Honeypot "company" non-empty -> return 200 ok silently without storing. Rate-limit-ish: per CF-Connecting-IP (hash it with SHA-256, don't store raw IP) counter key in KV with expirationTtl 3600, max 5/hour -> 429. Store key `email:<email>` value JSON {email, createdAt, source:"landing"}; if exists return {ok:true, status:"exists"}. Env binding WAITLIST: KVNamespace. Same-origin check optional. Return JSON with proper content-type. Include tsconfig/types via @cloudflare/workers-types in package.json devDeps.
5. wrangler.toml: name="skeletonkey", pages_build_output_dir="./public", compatibility_date="2026-10-01", [[kv_namespaces]] binding="WAITLIST" id="REPLACE_WITH_KV_NAMESPACE_ID".
6. package.json with scripts: dev = "wrangler pages dev", deploy = "wrangler pages deploy" (do not run deploy). README.md with deploy steps.
Keep total page weight tiny (<30KB). When done, print the file tree.

## Bei direction update (2026-10-25 13:54 PT) — OVERRIDES earlier sections
- Premium, high-end feel ("高逼格"). Restrained, confident, editorial.
- Main page talks ONLY about the problem solved and the benefits. No technical detail in the body (no architecture, runner internals, secret-resolution order, MCP specifics).
- All technical detail moves into the FAQ.
- Keep install command block minimal (one line + Claude Code / Codex tabs).
