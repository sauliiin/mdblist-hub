import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  EMPTY, Observable, catchError, expand, forkJoin, map, of, reduce, switchMap, throwError,
} from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { API, tmdbImg } from '../api.config';
import { noCache } from '../http-cache.interceptor';
import { currentLanguage, translate } from '../i18n.service';
import { MdbItem, MediaType, TmdbCard } from '../models';
import { ResumeItem, ScrobbleAction, ScrobbleTarget } from '../scrobble/models';
import { TmdbService } from '../tmdb.service';
import { TraktAuthService } from './trakt-auth.service';
import {
  TraktListItem, TraktPlaybackItem, TraktSyncResponse, TraktTitle, TraktWatchedItem,
  resolvedNothing,
} from './models';

/** What `LibraryService` asks for, in Trakt's own vocabulary. */
export type TraktBucket = 'watchlist' | 'watched' | 'collection';

/** Membership of one bucket: titles by TMDB id, plus watched episodes. */
export interface TraktMembership {
  titleIds: number[];
  /** `${showTmdbId}:${season}:${episode}`, the key `LibraryService` uses. */
  episodeKeys: string[];
}

/** See `API.trakt` — the packaged app talks to Trakt without a proxy. */
const BASE = Capacitor.isNativePlatform() ? API.trakt.api : API.trakt.apiProxy;

/** Trakt's paginated reads default to *ten* items, so every one asks. */
const PAGE = 100;
/** A stop, not a target: bounds a huge account instead of paging forever. */
const MAX_PAGES = 20;

/**
 * Trakt as the alternative to mdblist for the account's own library.
 *
 * Two things about this API shape everything below. Films and series live on
 * separate endpoints — there is no equivalent of mdblist's `unified=true` —
 * so every read here is two calls merged. And "watched" is not a bucket but
 * the play history: adding records a play and removing erases those plays,
 * which is the same whole-title meaning the detail page's button already
 * promises.
 */
@Injectable({ providedIn: 'root' })
export class TraktService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(TraktAuthService);
  private readonly tmdb = inject(TmdbService);

  readonly linked = this.auth.linked;

  // ------------------------------------------------------------ membership

  /**
   * Everything in [bucket], or null when no account is linked — null means
   * "leave what is cached alone", which is what keeps every library button
   * from blanking the moment a token expires.
   */
  membership(bucket: TraktBucket): Observable<TraktMembership | null> {
    if (!this.linked()) return of(null);

    const request =
      bucket === 'watched'
        ? this.watchedMembership()
        : forkJoin({
            movies: this.paged<TraktListItem>(this.listPath(bucket, 'movies')),
            shows: this.paged<TraktListItem>(this.listPath(bucket, 'shows')),
          }).pipe(
            map(({ movies, shows }) => ({
              titleIds: tmdbIds([...movies, ...shows]),
              episodeKeys: [],
            })),
          );

    return request.pipe(catchError(() => of(null)));
  }

  /**
   * `sync/watched` is not paginated the way the others are: Trakt answers
   * with the account's whole watched set at once. The shows half is also
   * where watched *episodes* come from — nested season by season, rather
   * than listed flat the way mdblist returns them.
   */
  private watchedMembership(): Observable<TraktMembership> {
    return forkJoin({
      movies: this.get<TraktWatchedItem[]>('/sync/watched/movies'),
      shows: this.get<TraktWatchedItem[]>('/sync/watched/shows'),
    }).pipe(
      map(({ movies, shows }) => {
        const episodeKeys: string[] = [];

        for (const entry of shows) {
          const showId = entry.show?.ids?.tmdb;
          if (!showId) continue;

          for (const season of entry.seasons ?? []) {
            if (season.number == null) continue;
            for (const episode of season.episodes ?? []) {
              if (episode.number == null) continue;
              episodeKeys.push(`${showId}:${season.number}:${episode.number}`);
            }
          }
        }

        return {
          titleIds: tmdbIds([...movies, ...shows] as TraktListItem[]),
          episodeKeys,
        };
      }),
    );
  }

  /** Adds or removes one title, resolving to the state Trakt settled on. */
  write(bucket: TraktBucket, target: LibraryLikeTarget, add: boolean): Observable<boolean> {
    // IMDb first: it is the id Trakt resolves most reliably for the titles
    // this app knows about, and the TMDB id is the one it always has.
    const ids = target.imdbId ? { imdb: target.imdbId } : { tmdb: target.tmdbId };
    const item = [{ ids }];
    const body = target.type === 'show' ? { shows: item } : { movies: item };

    const root = bucket === 'watched' ? '/sync/history' : `/sync/${bucket}`;
    const path = add ? root : `${root}/remove`;

    return this.request<TraktSyncResponse>('POST', path, { body }).pipe(
      map((response) => {
        if (resolvedNothing(response)) {
          throw new Error(translate('Trakt did not recognise this title.'));
        }
        return add;
      }),
    );
  }

  // ------------------------------------------------------------------ rows

  /**
   * One bucket as home-row cards, films only — the same shape and the same
   * "movies only" reading the mdblist rows already have. Trakt carries no
   * artwork, so each card's poster is one TMDB lookup (cached like every
   * other read, and skipped for entries TMDB has no id for).
   */
  movies(bucket: TraktBucket, limit: number): Observable<MdbItem[]> {
    if (!this.linked()) return of([]);

    const path =
      bucket === 'watched'
        ? '/sync/history/movies'
        : bucket === 'watchlist'
          ? '/sync/watchlist/movies/added/desc'
          : '/sync/collection/movies';

    return this.get<TraktListItem[]>(path, { limit }).pipe(
      map((entries) =>
        entries
          .slice()
          .sort((a, b) => timestamp(b).localeCompare(timestamp(a)))
          .map((entry) => entry.movie)
          .filter((movie): movie is TraktTitle => !!movie?.ids?.tmdb),
      ),
      // A history lists a film once per play, a collection once per copy.
      map((movies) => dedupe(movies).slice(0, limit)),
      switchMap((movies) =>
        movies.length
          ? forkJoin(movies.map((movie) => this.withArtwork(movie)))
          : of([] as MdbItem[]),
      ),
      catchError(() => of([])),
    );
  }

  private withArtwork(movie: TraktTitle): Observable<MdbItem> {
    const tmdbId = movie.ids!.tmdb!;

    return this.tmdb.card('movie', tmdbId).pipe(
      map((card) => toMdbItem(movie, card)),
      catchError(() => of(toMdbItem(movie, null))),
    );
  }

  // -------------------------------------------------------------- playback

  /**
   * Paused sessions, films and episodes merged.
   *
   * No extrapolation, unlike the mdblist path: Trakt reports a *paused*
   * position, and a paused film does not keep advancing while the tab is
   * closed.
   */
  sessions(): Observable<ResumeItem[]> {
    if (!this.linked()) return of([]);

    return forkJoin({
      movies: this.get<TraktPlaybackItem[]>('/sync/playback/movies', { limit: PAGE }),
      episodes: this.get<TraktPlaybackItem[]>('/sync/playback/episodes', { limit: PAGE }),
    }).pipe(
      map(({ movies, episodes }) =>
        [...movies, ...episodes]
          .map(toResumeItem)
          .filter((item): item is ResumeItem => !!item),
      ),
      catchError(() => of([])),
    );
  }

  /**
   * `start`, `pause` and `stop`, in Trakt's own shape: an episode names the
   * *show* and gives the episode as season plus number, rather than nesting
   * both under one object the way mdblist wants it.
   */
  scrobble(action: ScrobbleAction, target: ScrobbleTarget, progress: number): Observable<boolean> {
    // Trakt has no "clear" scrobble: a stored session is deleted by its own
    // id instead — see `clear` below, which is what the caller reaches for.
    if (action === 'clear') return of(false);

    const body = scrobbleBody(target, progress);
    if (!body) return of(false);

    return this.request<unknown>('POST', `/scrobble/${action}`, { body }).pipe(map(() => true));
  }

  /**
   * A stop that survives the tab closing.
   *
   * `sendBeacon` — what the mdblist path uses — cannot carry the bearer token
   * Trakt requires, so this is the other request a browser commits to
   * finishing once the page is going away: `fetch` with `keepalive`.
   */
  beaconStop(target: ScrobbleTarget, progress: number): void {
    const body = scrobbleBody(target, progress);
    if (!body) return;

    this.auth.token().subscribe((token) => {
      if (!token) return;

      void fetch(`${BASE}/scrobble/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-key': API.trakt.clientId,
          'trakt-api-version': API.trakt.version,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => undefined);
    });
  }

  /**
   * Drops a stored session. Addressed by the session's own id, which is why
   * `ResumeItem.playbackId` is carried all the way into the resume row.
   */
  clear(playbackId: number | null | undefined): Observable<boolean> {
    if (!playbackId) return of(false);
    return this.request<unknown>('DELETE', `/sync/playback/${playbackId}`).pipe(map(() => true));
  }

  // ------------------------------------------------------------------ http

  private listPath(bucket: TraktBucket, type: 'movies' | 'shows'): string {
    return bucket === 'watchlist'
      ? `/sync/watchlist/${type}/added/desc`
      : `/sync/collection/${type}`;
  }

  private get<T>(path: string, params: Record<string, string | number> = {}): Observable<T> {
    return this.request<T>('GET', path, { params });
  }

  /** Walks pages until one comes back short — see [PAGE]. */
  private paged<T>(path: string): Observable<T[]> {
    const page = (n: number) => this.get<T[]>(path, { limit: PAGE, page: n });

    return page(1).pipe(
      expand((batch, index) =>
        batch.length < PAGE || index + 2 > MAX_PAGES ? EMPTY : page(index + 2),
      ),
      reduce((all: T[], batch: T[]) => all.concat(batch), []),
    );
  }

  /**
   * Every call, with the one retry a rejected token earns.
   *
   * A Trakt access token lives seven days, so a site opened weekly is always
   * one request away from a 401. Renewing here rather than in each caller
   * makes it invisible: the call that triggered it completes normally.
   * Exactly one retry — a refresh token is single use, and looping would
   * spend the whole chain of them and end with the account unlinked.
   */
  private request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { body?: unknown; params?: Record<string, string | number> } = {},
  ): Observable<T> {
    return this.auth.token().pipe(
      switchMap((token) => {
        if (!token) return throwError(() => new Error(translate('No Trakt account linked.')));

        return this.send<T>(method, path, token, options).pipe(
          catchError((error: HttpErrorResponse) =>
            error.status === 401
              ? this.auth.renew().pipe(
                  switchMap((session) =>
                    session
                      ? this.send<T>(method, path, session.accessToken, options)
                      : throwError(() => error),
                  ),
                )
              : throwError(() => error),
          ),
        );
      }),
    );
  }

  private send<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    options: { body?: unknown; params?: Record<string, string | number> },
  ): Observable<T> {
    return this.http.request<T>(method, `${BASE}${path}`, {
      body: options.body,
      headers: this.auth.authHeaders(token),
      params: options.params,
      // Membership and sessions are read right after they are written, and a
      // ten-minute-old copy would undo the button the user just pressed.
      context: noCache(),
    });
  }
}

/**
 * The JSON one scrobble call carries, or null when there is nothing Trakt
 * could record a position against: an episode names the *show* and gives the
 * episode as season plus number, rather than nesting both under one object
 * the way mdblist wants it.
 */
function scrobbleBody(target: ScrobbleTarget, progress: number): Record<string, unknown> | null {
  if (!target.imdbId && !target.tmdbId) return null;

  const ids = target.imdbId ? { imdb: target.imdbId } : { tmdb: target.tmdbId };
  const body: Record<string, unknown> = { progress: Number(progress.toFixed(2)) };

  if (target.type === 'show') {
    // A series with no episode picked out is not something Trakt can record a
    // position against, and sending the show alone would scrobble the wrong
    // thing rather than nothing.
    if (target.season == null || target.episode == null) return null;
    body['show'] = { ids };
    body['episode'] = { season: target.season, number: target.episode };
  } else {
    body['movie'] = { ids };
  }

  return body;
}

/** `LibraryTarget` without the import — see `library.service.ts`. */
interface LibraryLikeTarget {
  imdbId: string | null;
  tmdbId: number;
  type: MediaType;
}

function tmdbIds(entries: TraktListItem[]): number[] {
  return entries
    .map((entry) => entry.movie?.ids?.tmdb ?? entry.show?.ids?.tmdb)
    .filter((id): id is number => typeof id === 'number');
}

/** Whichever timestamp the endpoint that produced this row carries. */
function timestamp(entry: TraktListItem): string {
  return entry.watched_at || entry.listed_at || entry.collected_at || entry.last_watched_at || '';
}

function dedupe(movies: TraktTitle[]): TraktTitle[] {
  const seen = new Set<number>();
  return movies.filter((movie) => {
    const id = movie.ids!.tmdb!;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function toMdbItem(movie: TraktTitle, card: TmdbCard | null): MdbItem {
  const tmdbId = movie.ids!.tmdb!;

  return {
    id: tmdbId,
    mediatype: 'movie',
    imdb_id: movie.ids?.imdb ?? null,
    ids: { imdb: movie.ids?.imdb, tmdb: tmdbId, trakt: movie.ids?.trakt, tvdb: movie.ids?.tvdb },
    title: movie.title || translate('Untitled'),
    language: '',
    country: '',
    release_year: movie.year ?? (card?.release_date ? Number(card.release_date.slice(0, 4)) : null),
    release_date: card?.release_date ?? null,
    runtime: card?.runtime ?? null,
    // Built straight at the size `MediaCard` upscales mdblist's own posters
    // to — this one comes from TMDB already, so there is nothing to rewrite.
    poster: tmdbImg(card?.poster_path, 'w342'),
    genre: null,
    rank: null,
  };
}

function toResumeItem(session: TraktPlaybackItem): ResumeItem | null {
  const isEpisode = !!session.episode || session.type === 'episode';
  const parent = isEpisode ? session.show : session.movie;
  const ids = parent?.ids ?? {};

  const tmdbId = ids.tmdb ?? null;
  const imdbId = ids.imdb ?? null;
  if (!tmdbId && !imdbId) return null;

  const season = session.episode?.season ?? null;
  const episode = session.episode?.number ?? null;

  return {
    key: `trakt:${session.id}`,
    title: parent?.title ?? translate('Untitled'),
    year: parent?.year ?? null,
    subtitle:
      isEpisode && season && episode
        ? `${currentLanguage() === 'pt' ? 'T' : 'S'}${season}E${episode}${session.episode?.title ? ` · ${session.episode.title}` : ''}`
        : null,
    progress: Math.min(100, Math.max(0, Math.round((session.progress ?? 0) * 10) / 10)),
    tmdbId,
    imdbId,
    type: isEpisode ? 'show' : 'movie',
    season,
    episode,
    playbackId: session.id,
  };
}
