/**
 * The Trakt shapes this app reads. Everything is optional: these are wire
 * objects, and a field missing from one endpoint's answer is not an error —
 * `history` carries `watched_at`, `watchlist` carries `listed_at`, and the
 * merged rows read whichever is there.
 */
export interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

export interface TraktTitle {
  title?: string;
  year?: number;
  ids?: TraktIds;
}

export interface TraktEpisode {
  season?: number;
  number?: number;
  title?: string;
  ids?: TraktIds;
}

/** One row of `sync/watchlist`, `sync/collection` or `sync/history`. */
export interface TraktListItem {
  /** `sync/history` only, and its own id — not the title's. */
  id?: number;
  type?: 'movie' | 'show' | 'season' | 'episode';
  listed_at?: string;
  collected_at?: string;
  watched_at?: string;
  last_watched_at?: string;
  movie?: TraktTitle;
  show?: TraktTitle;
  episode?: TraktEpisode;
}

/**
 * One row of `sync/watched/shows`, which is where the watched *episodes* come
 * from: Trakt nests them under the show, season by season, rather than
 * listing them flat the way mdblist does.
 */
export interface TraktWatchedItem {
  plays?: number;
  last_watched_at?: string;
  movie?: TraktTitle;
  show?: TraktTitle;
  seasons?: { number?: number; episodes?: { number?: number }[] }[];
}

/** One row of `sync/playback/{movies|episodes}`. */
export interface TraktPlaybackItem {
  /** Trakt's id for the *session*; a session is deleted by this, not by title. */
  id: number;
  progress: number;
  paused_at?: string | null;
  type?: 'movie' | 'episode';
  movie?: TraktTitle;
  show?: TraktTitle;
  episode?: TraktEpisode;
}

/** What `POST /sync/*` answers. See `resolvedNothing` below. */
export interface TraktSyncResponse {
  added?: Record<string, number>;
  deleted?: Record<string, number>;
  not_found?: Record<string, unknown[]>;
}

/** The stored credential. `expiresAt` is epoch ms, unlike Trakt's own pair. */
export interface TraktSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** The linked account, as the addons page names it. */
export interface TraktAccount {
  username: string;
  name?: string | null;
}

/** The pair the device flow hands back at the start of a link. */
export interface TraktDeviceCode {
  /** What the person types on trakt.tv/activate. */
  userCode: string;
  verificationUrl: string;
  deviceCode: string;
  /** Seconds between polls. Going faster than Trakt asked for earns a 429. */
  intervalSeconds: number;
  /** Seconds the pair stays valid — the countdown the panel shows. */
  expiresInSeconds: number;
}

/**
 * How far along linking an account is. `failure` carries a reason rather than
 * a sentence: the strings belong to the component, which is where the
 * interface language is known.
 */
export type TraktLinkFailure =
  /** The ten-minute window closed before anyone approved the code. */
  | 'expired'
  /** The user pressed "Deny" on trakt.tv. */
  | 'denied'
  /** Network, or anything Trakt answered that this flow does not model. */
  | 'unavailable';

export type TraktLinkState =
  | { kind: 'requesting' }
  | { kind: 'awaiting'; code: TraktDeviceCode; secondsRemaining: number }
  | { kind: 'linked'; account: TraktAccount | null }
  | { kind: 'failed'; reason: TraktLinkFailure };

/**
 * A `201` whose every id landed in `not_found` is a failure wearing a success
 * code — Trakt accepted the request and stored nothing, because it did not
 * recognise the title. Without this check a button would settle on a state
 * Trakt never recorded.
 */
export function resolvedNothing(response: TraktSyncResponse | null): boolean {
  if (!response) return false;

  const counted = (group?: Record<string, number>) =>
    Object.values(group ?? {}).reduce((total, value) => total + (value ?? 0), 0);

  const missing = Object.values(response.not_found ?? {}).reduce(
    (total, list) => total + (Array.isArray(list) ? list.length : 0),
    0,
  );

  return missing > 0 && counted(response.added) + counted(response.deleted) === 0;
}
