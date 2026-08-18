/**
 * Same-origin proxies for the APIs that cannot be called from a browser
 * directly, plus the static site.
 *
 * mdblist answers a JSON POST's CORS preflight with 405, and Trakt sends no
 * CORS headers at all — reached through this Worker both are same-origin
 * requests, which are never preflighted. `proxy.config.json` (dev server) and
 * `vercel.json` mirror this table; all three have to agree.
 */
const PROXIES = {
  "/mdblist-api/": "https://api.mdblist.com/",
  "/opensubtitles-api/": "https://api.opensubtitles.com/api/v1/",
  "/trakt-api/": "https://api.trakt.tv/",
  "/trakt-auth/": "https://auth.trakt.tv/",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    for (const [prefix, target] of Object.entries(PROXIES)) {
      if (!url.pathname.startsWith(prefix)) continue;

      const targetUrl = target + url.pathname.slice(prefix.length) + url.search;

      return fetch(
        new Request(targetUrl, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
        }),
      );
    }

    // Serve all other requests from the static assets
    return env.ASSETS.fetch(request);
  },
};
