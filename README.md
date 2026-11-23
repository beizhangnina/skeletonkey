# skeletonkey.run landing page

Static page (`public/`) + Cloudflare Pages Function (`functions/api/waitlist.ts`) storing waitlist emails in KV binding `WAITLIST`. No analytics, no CDNs: the three variable web fonts are served first-party from `public/fonts/` (107 KB total, subset to Latin). This is **v2** of the page — see the two addenda at the end of `DESIGN.md` for what changed and why. v2.1 makes install the hero action: two doors side by side, with Claude Code / Codex install tabs under the open source one. The waitlist function and its client contract are unchanged.

Local: `npm install && npm run dev` (http://127.0.0.1:8788, local KV simulated).

## Deploy (not done yet)
1. `npx wrangler login`  (or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
2. `npx wrangler kv namespace create WAITLIST` → paste the id into `wrangler.toml` (replace `REPLACE_WITH_KV_NAMESPACE_ID`)
3. `npx wrangler pages project create skeletonkey --production-branch main`
4. `npm run deploy`  (= `wrangler pages deploy`)
5. Cloudflare dashboard → Pages → skeletonkey → Custom domains → add `skeletonkey.run` (DNS zone must be on Cloudflare, or add the CNAME at the registrar).

Read signups: `npx wrangler kv key list --binding WAITLIST --prefix email: --remote`
