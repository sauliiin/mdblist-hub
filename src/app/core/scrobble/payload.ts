import type { ScrobbleTarget } from './models';

export interface ScrobbleIds {
  imdb?: string;
  tmdb?: number;
}

export interface ScrobbleShow {
  ids: ScrobbleIds;
  season?: {
    number: number;
    episode: { number: number };
  };
}

export interface ScrobblePayload {
  progress: number;
  movie?: { ids: ScrobbleIds };
  show?: ScrobbleShow;
}

/**
 * Builds the exact JSON shape documented by mdblist.
 *
 * Episodes are nested under `show.season.episode`; sending `season` and
 * `episode` as sibling numbers makes the API reject the target as if no valid
 * `show` had been supplied, producing "Either 'movie' or 'show' must be
 * provided".
 */
export function scrobbleBody(target: ScrobbleTarget, progress: number): ScrobblePayload {
  const ids: ScrobbleIds = {};
  if (target.imdbId) ids.imdb = target.imdbId;
  if (target.tmdbId) ids.tmdb = target.tmdbId;

  const payload: ScrobblePayload = { progress: Number(progress.toFixed(2)) };

  if (target.type === 'show') {
    const show: ScrobbleShow = { ids };
    if (target.season != null && target.episode != null) {
      show.season = {
        number: target.season,
        episode: { number: target.episode },
      };
    }
    payload.show = show;
  } else {
    payload.movie = { ids };
  }

  return payload;
}
