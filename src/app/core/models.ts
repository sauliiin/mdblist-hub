/** `movie` | `show` is mdblist/Trakt vocabulary, `movie` | `tv` is TMDB's. */
export type MediaType = 'movie' | 'show';

export function toTmdbType(type: MediaType): 'movie' | 'tv' {
  return type === 'show' ? 'tv' : 'movie';
}

export function toMediaType(tmdbType: string): MediaType {
  return tmdbType === 'tv' ? 'show' : 'movie';
}

/** Returns a safe four-digit year for a card caption. */
export function formatYear(year: string | number | null | undefined): string | null {
  const value = String(year ?? '').trim();
  return /^\d{4}$/.test(value) ? value : null;
}

/** Formats the accessible label shared by poster cards. */
export function titleWithYear(
  title: string,
  year: string | number | null | undefined,
): string {
  const value = formatYear(year);
  return value ? `${title} (${value})` : title;
}

// ---------------------------------------------------------------- mdblist

/** What `GET /user` answers — the account behind the API key. */
export interface MdbUser {
  user_id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  patron_status?: string;
  plan?: string;
  api_requests?: number;
  api_requests_count?: number;
}

export interface MdbList {
  id: number;
  /** Portuguese label once the list passes through `curate()`. */
  name: string;
  /** The untouched mdblist name, set by `curate()`. */
  originalName?: string;
  slug: string;
  description: string;
  mediatype: MediaType | null;
  items: number;
  likes: number;
  dynamic: boolean;
  private: boolean;
  last_updated_at: string;
}

export interface MdbItem {
  id: number; // tmdb id
  mediatype: MediaType;
  imdb_id: string | null;
  ids: { imdb?: string; tmdb?: number; tvdb?: number; trakt?: number };
  title: string;
  language: string;
  country: string;
  release_year: number | null;
  release_date: string | null;
  runtime: number | null;
  poster: string | null;
  genre: string[] | null;
  rank: number | null;
  /** Only present with `append_to_response=ratings`. */
  ratings?: MdbRating[];
}

export interface MdbRating {
  source: string;
  value: number | null;
  score: number | null;
  votes: number | null;
  url?: string | number | null;
  fresh?: number;
}

/**
 * mdblist mirrors reviews from other platforms. `provider_id` identifies the
 * origin: 1 = Trakt, 2 = TMDB.
 */
export interface MdbReview {
  author: string;
  content: string;
  rating: number | null;
  updated_at: string;
  provider_id: number;
}

export interface MdbInfo {
  title: string;
  year: number | null;
  released: string | null;
  description: string | null;
  tagline: string | null;
  runtime: number | null;
  budget: number | null;
  revenue: number | null;
  score: number | null;
  score_average: number | null;
  ids: { imdb?: string; trakt?: number; tmdb?: number; tvdb?: number };
  type: string;
  ratings: MdbRating[];
  /** Only present with `append_to_response=review`. */
  reviews?: MdbReview[];
  keywords?: { id: number; name: string }[];
  streams?: { id: number; name: string }[];
  watch_providers?: { id: number; name: string }[];
}

// ------------------------------------------------------------------- TMDB

export interface TmdbCastMember {
  id: number;
  name: string;
  character?: string;
  roles?: { character: string; episode_count: number }[];
  profile_path: string | null;
  order?: number;
  total_episode_count?: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job?: string;
  jobs?: { job: string }[];
  department: string;
  profile_path: string | null;
}

export interface TmdbVideo {
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface TmdbDetail {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview: string | null;
  tagline: string | null;
  backdrop_path: string | null;
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string;
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  seasons?: TmdbSeasonSummary[];
  status: string;
  vote_average: number;
  vote_count: number;
  budget?: number;
  revenue?: number;
  homepage: string | null;
  genres: { id: number; name: string }[];
  production_companies: { id: number; name: string; logo_path: string | null }[];
  spoken_languages: { english_name: string }[];
  credits?: { cast: TmdbCastMember[]; crew: TmdbCrewMember[] };
  aggregate_credits?: { cast: TmdbCastMember[]; crew: TmdbCrewMember[] };
  external_ids?: { imdb_id: string | null; tvdb_id: number | null };
  videos?: { results: TmdbVideo[] };
  recommendations?: { results: TmdbRecommendation[] };
}

/** A season as listed on the show record. */
export interface TmdbSeasonSummary {
  id: number;
  season_number: number;
  name: string;
  episode_count: number;
  air_date: string | null;
  poster_path: string | null;
}

/** A season with its episodes, from `/tv/{id}/season/{n}`. */
export interface TmdbSeason {
  id: number;
  season_number: number;
  name: string;
  episodes: TmdbEpisode[];
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  overview: string | null;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
  vote_average: number;
}

export interface TmdbRecommendation {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  media_type?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
  known_for_department: string | null;
  profile_path: string | null;
  homepage: string | null;
  popularity: number;
  external_ids?: { imdb_id: string | null; wikidata_id: string | null };
  combined_credits?: { cast: TmdbPersonCredit[] };
}

export interface TmdbPersonCredit {
  id: number;
  title?: string;
  name?: string;
  character?: string;
  media_type: string;
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_count: number;
  popularity: number;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

/** Movie and TV genre lists overlap by name but not by id. */
export interface GenreOption {
  /** Portuguese label, for the dropdown. */
  name: string;
  /**
   * The English name lowercased, which is exactly how mdblist tags its list
   * items — this is what matches a genre against the user's own lists.
   */
  slug: string;
  movieId: number | null;
  tvId: number | null;
}

/** One tile in the results grid, whatever the source. */
export interface GridItem {
  key: string;
  id: number;
  tmdbType: 'movie' | 'tv';
  title: string;
  poster: string | null;
  year: string;
  vote: number | null;
}

export interface TmdbKeyword {
  id: number;
  name: string;
}

export interface TmdbSearchResult {
  id: number;
  media_type: string;
  genre_ids?: number[];
  title?: string;
  name?: string;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  popularity: number;
}

export interface TmdbReview {
  id: string;
  author: string;
  author_details: { name: string; username: string; avatar_path: string | null; rating: number | null };
  content: string;
  created_at: string;
  url: string;
}

// ------------------------------------------------------------------- OMDb

export interface OmdbResponse {
  Response: 'True' | 'False';
  Error?: string;
  Title?: string;
  Year?: string;
  Rated?: string;
  Released?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Writer?: string;
  Actors?: string;
  Plot?: string;
  Language?: string;
  Country?: string;
  Awards?: string;
  Poster?: string;
  Ratings?: { Source: string; Value: string }[];
  Metascore?: string;
  imdbRating?: string;
  imdbVotes?: string;
  imdbID?: string;
  BoxOffice?: string;
  Production?: string;
  totalSeasons?: string;
}

// ------------------------------------------------------- view-model types

/** A rating normalised for display as a badge. */
export interface RatingBadge {
  key: string;
  label: string;
  display: string;
  /** 0-100, drives the progress ring. */
  score: number | null;
  votes: number | null;
  tone: 'imdb' | 'rt-fresh' | 'rt-rotten' | 'metacritic' | 'trakt' | 'tmdb' | 'letterboxd' | 'neutral';
}

/** A review, whatever its origin. */
export interface Review {
  id: string;
  author: string;
  avatar: string | null;
  content: string;
  rating: number | null;
  /** Scale of `rating`, for rendering (`/10` for both sources today). */
  createdAt: string;
  likes: number | null;
  spoiler: boolean;
  /** The platform the review was written on. */
  source: 'trakt' | 'tmdb';
  /** Set when the review reached us mirrored through mdblist. */
  via: 'mdblist' | null;
  url: string | null;
}

/** Everything the detail page renders, assembled from all four APIs. */
export interface MediaDetail {
  type: MediaType;
  tmdbId: number;
  imdbId: string | null;
  title: string;
  originalTitle: string | null;
  tagline: string | null;
  overview: string | null;
  backdrop: string | null;
  poster: string | null;
  year: number | null;
  releaseDate: string | null;
  runtime: number | null;
  seasons: number | null;
  episodes: number | null;
  status: string | null;
  genres: string[];
  cast: TmdbCastMember[];
  directors: string[];
  writers: string[];
  companies: string[];
  trailerKey: string | null;
  homepage: string | null;
  ratings: RatingBadge[];
  reviews: Review[];
  recommendations: TmdbRecommendation[];
  omdb: OmdbResponse | null;
  budget: number | null;
  revenue: number | null;
}
