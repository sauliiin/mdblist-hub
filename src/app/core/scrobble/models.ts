import { MediaType } from '../models';

/** What a scrobble call points at. */
export interface ScrobbleTarget {
  type: MediaType;
  imdbId: string | null;
  tmdbId: number;
  /** Only for shows; both are needed for the episode to be identified. */
  season?: number | null;
  episode?: number | null;
}

export type ScrobbleAction = 'start' | 'pause' | 'stop' | 'clear';

/**
 * One entry of `GET /sync/playback`.
 *
 * `movie`, `episode` and `show` are declared as bare objects in mdblist's
 * OpenAPI schema, so the fields below are what they turn out to carry, all
 * optional — nothing here assumes more than it can check.
 */
export interface PlaybackSession {
  id: number;
  /** 0–100. */
  progress: number;
  /** Progress as of `updated_at`; with `runtime` it estimates the live point. */
  progress_at_update?: number;
  updated_at?: string;
  updated_at_ts?: number;
  expires_at?: string | null;
  /** Minutes, or 0 when mdblist does not know it. */
  runtime?: number;
  paused_at?: string | null;
  is_manual?: boolean;
  type: 'movie' | 'episode';
  movie?: TitleRef | null;
  show?: TitleRef | null;
  episode?: EpisodeRef | null;
}

export interface TitleRef {
  title?: string;
  year?: number;
  ids?: { imdb?: string; tmdb?: number; trakt?: number; tvdb?: number };
}

export interface EpisodeRef {
  title?: string;
  season?: number;
  number?: number;
  episode?: number;
  ids?: { imdb?: string; tmdb?: number };
}

/** A `/sync/playback` entry flattened into what the "continue watching" row needs. */
export interface ResumeItem {
  key: string;
  title: string;
  subtitle: string | null;
  progress: number;
  tmdbId: number | null;
  imdbId: string | null;
  type: MediaType;
  season: number | null;
  episode: number | null;
}

/**
 * Reads one session into the row's shape. Returns null when the entry carries
 * no id we can route by — there is nowhere to send a click without one.
 */
export function toResumeItem(session: PlaybackSession): ResumeItem | null {
  const isEpisode = session.type === 'episode';
  const parent = isEpisode ? session.show : session.movie;
  const ids = parent?.ids ?? {};

  const tmdbId = ids.tmdb ?? null;
  const imdbId = ids.imdb ?? null;
  if (!tmdbId && !imdbId) return null;

  const season = session.episode?.season ?? null;
  const episode = session.episode?.number ?? session.episode?.episode ?? null;

  return {
    key: `${session.id}`,
    title: parent?.title ?? 'Sem título',
    subtitle: isEpisode && season && episode
      ? `T${season}E${episode}${session.episode?.title ? ` · ${session.episode.title}` : ''}`
      : parent?.year
        ? String(parent.year)
        : null,
    progress: clampProgress(liveProgress(session)),
    tmdbId,
    imdbId,
    type: isEpisode ? 'show' : 'movie',
    season,
    episode,
  };
}

/**
 * mdblist stores the progress captured at `updated_at` and expects clients to
 * carry it forward themselves — the schema says as much. A session left
 * playing on another device would otherwise show a point already long past.
 */
function liveProgress(session: PlaybackSession): number {
  const stored = session.progress ?? 0;

  // Paused sessions are frozen by definition; only a running one drifts.
  if (session.paused_at || !session.updated_at_ts || !session.runtime) return stored;

  const base = session.progress_at_update ?? stored;
  const elapsedMinutes = (Date.now() / 1000 - session.updated_at_ts) / 60;
  return base + (elapsedMinutes / session.runtime) * 100;
}

function clampProgress(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
