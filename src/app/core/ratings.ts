import { MdbRating, OmdbResponse, RatingBadge } from './models';

interface SourceSpec {
  label: string;
  tone: RatingBadge['tone'];
  /** Renders the human-facing value. */
  display: (value: number, rating: MdbRating) => string;
  /** Normalises the value to 0-100 for the progress ring. */
  score: (value: number) => number;
  order: number;
}

const SOURCES: Record<string, SourceSpec> = {
  imdb: {
    label: 'IMDb', tone: 'imdb', order: 1,
    display: (v) => `${v.toFixed(1)}`, score: (v) => v * 10,
  },
  tomatoes: {
    label: 'Tomatometer', tone: 'rt-fresh', order: 2,
    display: (v) => `${Math.round(v)}%`, score: (v) => v,
  },
  popcorn: {
    label: 'RT Público', tone: 'rt-fresh', order: 3,
    display: (v) => `${Math.round(v)}%`, score: (v) => v,
  },
  metacritic: {
    label: 'Metacritic', tone: 'metacritic', order: 4,
    display: (v) => `${Math.round(v)}`, score: (v) => v,
  },
  metacriticuser: {
    label: 'Metacritic Users', tone: 'metacritic', order: 8,
    display: (v) => v.toFixed(1), score: (v) => v * 10,
  },
  letterboxd: {
    label: 'Letterboxd', tone: 'letterboxd', order: 5,
    display: (v) => `${v.toFixed(1)}/5`, score: (v) => (v / 5) * 100,
  },
  trakt: {
    label: 'Trakt', tone: 'trakt', order: 6,
    display: (v) => `${Math.round(v)}%`, score: (v) => v,
  },
  tmdb: {
    label: 'TMDB', tone: 'tmdb', order: 7,
    display: (v) => `${Math.round(v)}%`, score: (v) => v,
  },
  rogerebert: {
    label: 'Roger Ebert', tone: 'neutral', order: 9,
    display: (v) => `${v.toFixed(1)}/4`, score: (v) => (v / 4) * 100,
  },
  myanimelist: {
    label: 'MyAnimeList', tone: 'neutral', order: 10,
    display: (v) => v.toFixed(1), score: (v) => v * 10,
  },
};

/** Turns mdblist's raw ratings array into ordered, display-ready badges. */
export function toBadges(ratings: MdbRating[] | undefined | null): RatingBadge[] {
  if (!ratings?.length) return [];

  return ratings
    .filter((r) => r.value !== null && r.value !== undefined && SOURCES[r.source])
    .map((r) => {
      const spec = SOURCES[r.source];
      const value = r.value as number;
      const tone: RatingBadge['tone'] =
        spec.tone === 'rt-fresh' && !isFresh(r, value) ? 'rt-rotten' : spec.tone;

      return {
        key: r.source,
        label: spec.label,
        display: spec.display(value, r),
        score: clamp(r.score ?? spec.score(value)),
        votes: r.votes ?? null,
        tone,
        _order: spec.order,
      };
    })
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...badge }) => badge);
}

/** Fallback badges when mdblist has nothing but OMDb answered. */
export function badgesFromOmdb(omdb: OmdbResponse | null): RatingBadge[] {
  if (!omdb) return [];
  const badges: RatingBadge[] = [];

  if (omdb.imdbRating && omdb.imdbRating !== 'N/A') {
    const value = Number(omdb.imdbRating);
    badges.push({
      key: 'imdb', label: 'IMDb', display: value.toFixed(1),
      score: value * 10, votes: parseVotes(omdb.imdbVotes), tone: 'imdb',
    });
  }

  const rt = omdb.Ratings?.find((r) => r.Source === 'Rotten Tomatoes');
  if (rt) {
    const value = Number(rt.Value.replace('%', ''));
    badges.push({
      key: 'tomatoes', label: 'Tomatometer', display: `${value}%`,
      score: value, votes: null, tone: value >= 60 ? 'rt-fresh' : 'rt-rotten',
    });
  }

  if (omdb.Metascore && omdb.Metascore !== 'N/A') {
    const value = Number(omdb.Metascore);
    badges.push({
      key: 'metacritic', label: 'Metacritic', display: `${value}`,
      score: value, votes: null, tone: 'metacritic',
    });
  }

  return badges;
}

function isFresh(rating: MdbRating, value: number): boolean {
  return rating.fresh === 1 || (rating.fresh === undefined && value >= 60);
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseVotes(votes: string | undefined): number | null {
  if (!votes || votes === 'N/A') return null;
  const n = Number(votes.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}
