/**
 * Central place for every external API used by the app.
 * All four endpoints are called straight from the browser (they all send
 * `Access-Control-Allow-Origin: *`), so no backend/proxy is required.
 */
export const API = {
  mdblist: {
    base: 'https://api.mdblist.com',
    key: 'omqfcrbt1dm8hj98mwuvgpg9n',
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
