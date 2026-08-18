/**
 * Central place for every external API used by the app.
 * All four endpoints are called straight from the browser (they all send
 * `Access-Control-Allow-Origin: *`), so no backend/proxy is required.
 *
 * mdblist has no key here on purpose: it is per-visitor and comes from the
 * login screen (`core/auth.service.ts`), not from the bundle.
 */
export const API = {
  mdblist: {
    base: 'https://api.mdblist.com',
    writeProxy: '/mdblist-api',
  },
  tmdb: {
    base: 'https://api.themoviedb.org/3',
    key: '703cf5598b9fd74adac824baf7923126',
    img: 'https://image.tmdb.org/t/p',
  },
  omdb: {
    base: 'https://www.omdbapi.com',
    key: 'b2f2fcca',
  },
  openSubtitles: {
    base: 'https://api.opensubtitles.com/api/v1',
    /** Same-origin route supplied by `proxy.config.json` / `public/_redirects`. */
    webProxy: '/opensubtitles-api',
    key: '9eBRI85k0K0D7teGENPWBhCrCH4jnsLF',
    userAgent: 'mestreyoddarossi api for kodi',
  },
  wyzie: {
    base: 'https://sub.wyzie.io',
    key: 'wyzie-s9qb8pabb1bllkptwqe0z19ufdnpa5sa',
  },
  /**
   * Trakt, the alternative to mdblist for watchlist / collection / watched and
   * the playback position behind "continue watching".
   *
   * Two hosts, not one: the device-code dance lives on `auth.` and everything
   * else on `api.` — sending an OAuth request to the API host answers 404,
   * which looks exactly like a bad client id.
   *
   * The client id/secret are the ones `plugin.video.pov` (a Kodi addon) ships
   * as its default, the same pair the native apps borrow — creating a new
   * Trakt registration now requires VIP. Borrowing carries the risk any shared
   * key does: it is another project's identity, revocable at any time. If
   * every Trakt call starts failing at once, this is the first thing to check.
   * The secret is in the bundle, as it is in the APK — a device-code flow run
   * from a client has nowhere else to keep it.
   */
  trakt: {
    api: 'https://api.trakt.tv',
    auth: 'https://auth.trakt.tv',
    /**
     * Same-origin routes supplied by `proxy.config.json` (dev), `vercel.json`
     * and `worker.js` (production). Trakt answers browsers with neither CORS
     * headers nor an OPTIONS preflight, so every call from the web build goes
     * through them; the packaged app, which has no such rule, talks to the
     * hosts above directly.
     */
    apiProxy: '/trakt-api',
    authProxy: '/trakt-auth',
    version: '2',
    /** Where the user types the code the device flow shows them. */
    activateUrl: 'https://trakt.tv/activate',
    clientId: '6bc29124c3d9466e06a3ed19a7b5976fcb28311008401e1ce04cf08196f8b16a',
    clientSecret: '99478842b17d44d7accafef45c6c1bbba235792753c195069ae149595cd3a919',
  },
  /** Same key the native apps ship — see `LandscapeArtworkService` for how it's used. */
  fanart: {
    base: 'https://webservice.fanart.tv/v3.2',
    key: 'a7ad21743fd710fccb738232f2fbdcfc',
  },
} as const;

export type TmdbImageSize =
  | 'w92' | 'w154' | 'w185' | 'w200' | 'w300' | 'w342' | 'w500' | 'w780'
  | 'w1280' | 'original';

/** Builds a TMDB image URL from a bare path (`/abc.jpg`). */
export function tmdbImg(path: string | null | undefined, size: TmdbImageSize): string | null {
  return path ? `${API.tmdb.img}/${size}${path}` : null;
}

/**
 * mdblist hands out posters already sized at `w200`, which looks soft on
 * retina cards. Rewriting the size segment gets us a sharper file for free.
 */
export function upscalePoster(url: string | null | undefined, size: TmdbImageSize = 'w342'): string | null {
  if (!url) return null;
  return url.replace(/\/t\/p\/w\d+\//, `/t/p/${size}/`);
}
