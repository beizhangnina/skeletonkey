/**
 * The API Directory's addresses — the one place the frontend keeps them.
 *
 * T7b (this change) ships ahead of T7a (the index server's production deploy),
 * so the values below are deliberately provisional. When T7a's production URL
 * lands, it is changed here and nowhere else.
 */

/**
 * Where the "Directory" entry in the site navigation points.
 *
 * It is a path on this site today, because the index server speaks JSON only
 * (`GET /v1/index/*`) and has no HTML surface to link a visitor to — so the
 * landing page is served from `public/directory/`.
 *
 * If T7a ends up publishing its own hosted landing page, set this to that
 * absolute URL: the nav reads this constant, so the link follows on its own.
 */
export const DIRECTORY_URL = "/directory/";

/**
 * Base the landing page reads index data from, without the trailing slash.
 *
 * Same-origin on purpose. The index server sends no `Access-Control-Allow-Origin`
 * (see `src/http.ts` in skeletonkey-index-server), so a browser cannot call it
 * cross-origin at all; `/api/directory/*` is this site's own Pages Function
 * (`functions/api/directory/[[path]].ts`) forwarding the request untouched.
 *
 * If T7a routes the Worker onto skeletonkey.run itself, set this to `/v1` and
 * the proxy function stops being used.
 */
export const INDEX_BASE = "/api/directory";
