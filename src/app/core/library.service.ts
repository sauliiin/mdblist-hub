import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, tap } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { API } from './api.config';
import { translate } from './i18n.service';
import { AuthService } from './auth.service';
import { MdbItem, MediaType } from './models';

/** The three mdblist buckets a title can belong to. */
export type Bucket = 'watchlist' | 'watched' | 'collection';

export type LibraryStatus = Record<Bucket, boolean>;

export interface LibraryTarget {
  imdbId: string | null;
  tmdbId: number;
  type: MediaType;
}

/**
 * Writes go through the dev-server proxy (`proxy.config.json`), not straight
 * to api.mdblist.com. A cross-origin POST with a JSON body triggers a CORS
 * preflight, and mdblist answers OPTIONS with 405 — so the browser blocks it.
 * The API only accepts a JSON body (form-encoded is mis-parsed), which leaves
 * proxying as the only route. Reads are plain GETs and need no proxy.
 */
const WRITE_BASE = Capacitor.isNativePlatform() ? API.mdblist.base : '/mdblist-api';

/**
 * The write endpoints and the reads that back them. All three take
 * `{movies: [...], shows: [...]}` with items keyed by `imdb` or `tmdb`.
 */
const ROUTES: Record<Bucket, { read: string; add: string; remove: string }> = {
  watchlist: {
    read: '/watchlist/items',
    add: '/watchlist/items/add',
    remove: '/watchlist/items/remove',
  },
  watched: {
    read: '/sync/watched',
    add: '/sync/watched',
    remove: '/sync/watched/remove',
  },
  collection: {
    read: '/sync/collection',
    add: '/sync/collection',
    remove: '/sync/collection/remove',
  },
};

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  /**
   * Membership sets keyed by TMDB id, filled on the first read and kept in
   * step with every write — so the buttons stay correct without re-fetching
   * the (interceptor-cached) lists after each toggle.
   */
  private readonly members = new Map<Bucket, Set<number>>();

  /** Set of watched episodes formatted as `${showTmdbId}:${season}:${episode}`. */
  private readonly watchedEpisodes = new Set<string>();

  /** Signal incremented on watched sets updates to drive reactive UI bindings. */
  readonly watchedVersion = signal<number>(0);

  constructor() {
    // Another account has another watchlist, collection and history.
    effect(() => {
      const key = this.auth.key();
      this.members.clear();
      this.watchedEpisodes.clear();
      this.watchedVersion.update((v) => v + 1);
      if (key) {
        // Eagerly populate watched set
        this.ids('watched').subscribe();
      }
    });
  }

  /** Checks if a movie or series (or any of its episodes) is watched. */
  isWatched(tmdbId: number): boolean {
    // Access signal to register reactive dependency in computed() callers
    this.watchedVersion();
    return this.members.get('watched')?.has(tmdbId) ?? false;
  }

  /** Checks if a specific episode is watched. */
  isEpisodeWatched(showTmdbId: number, season: number, episode: number): boolean {
    this.watchedVersion();
    return this.watchedEpisodes.has(`${showTmdbId}:${season}:${episode}`);
  }

  /** Gets all watched episode keys (`${showTmdbId}:${season}:${episode}`). */
  getWatchedEpisodes(): Observable<Set<string>> {
    return this.ids('watched').pipe(map(() => this.watchedEpisodes));
  }

  /** Whether the title is already in each bucket. */
  status(target: LibraryTarget): Observable<LibraryStatus> {
    return forkJoin({
      watchlist: this.ids('watchlist'),
      watched: this.ids('watched'),
      collection: this.ids('collection'),
    }).pipe(
      map((sets) => ({
        watchlist: sets.watchlist.has(target.tmdbId),
        watched: sets.watched.has(target.tmdbId),
        collection: sets.collection.has(target.tmdbId),
      })),
      catchError(() => of({
        watchlist: this.members.get('watchlist')?.has(target.tmdbId) ?? false,
        watched: this.members.get('watched')?.has(target.tmdbId) ?? false,
        collection: this.members.get('collection')?.has(target.tmdbId) ?? false,
      })),
    );
  }

  /** Adds or removes the title, resolving to the new membership state. */
  toggle(bucket: Bucket, target: LibraryTarget, add: boolean): Observable<boolean> {
    const route = add ? ROUTES[bucket].add : ROUTES[bucket].remove;
    const key = target.imdbId ? { imdb: target.imdbId } : { tmdb: target.tmdbId };
    const body = target.type === 'show' ? { shows: [key] } : { movies: [key] };

    return this.http
      .post<unknown>(`${WRITE_BASE}${route}`, body, {
        params: { apikey: this.auth.key() },
      })
      .pipe(
        map(() => add),
        tap((state) => {
          const set = this.members.get(bucket);
          if (!set) return;
          state ? set.add(target.tmdbId) : set.delete(target.tmdbId);
          this.watchedVersion.update((v) => v + 1);
        }),
      );
  }

  /**
   * Movies mdblist has marked watched, most recent first — the same
   * `sync/watched` bucket `ids()` reads for membership below, just with the
   * `append_to_response` extras a real row needs (poster, title, year).
   */
  recentlyWatchedMovies(limit = 30): Observable<MdbItem[]> {
    return this.entries('watched', limit).pipe(
      map((entries) =>
        entries
          .slice()
          .sort((a, b) => (b.last_watched_at ?? '').localeCompare(a.last_watched_at ?? ''))
          .map(fromBucketEntry)
          .filter((item): item is MdbItem => item !== null),
      ),
    );
  }

  /** Movies on the account's watchlist, in mdblist's own order. */
  watchlistMovies(limit = 30): Observable<MdbItem[]> {
    return this.bucketMovies('watchlist', limit);
  }

  /** Movies in the account's collection, in mdblist's own order. */
  collectionMovies(limit = 30): Observable<MdbItem[]> {
    return this.bucketMovies('collection', limit);
  }

  private bucketMovies(bucket: Bucket, limit: number): Observable<MdbItem[]> {
    return this.entries(bucket, limit).pipe(
      map((entries) => entries.map(fromBucketEntry).filter((item): item is MdbItem => item !== null)),
    );
  }

  private entries(bucket: Bucket, limit: number): Observable<BucketEntry[]> {
    return this.http
      .get<BucketResponse>(`${API.mdblist.base}${ROUTES[bucket].read}`, {
        params: { apikey: this.auth.key(), limit, append_to_response: 'poster,ratings' },
      })
      .pipe(
        map((res) => res.movies ?? []),
        catchError(() => of([])),
      );
  }

  ids(bucket: Bucket): Observable<Set<number>> {
    const cached = this.members.get(bucket);
    if (cached) return of(cached);

    return this.http
      .get<BucketResponse>(`${API.mdblist.base}${ROUTES[bucket].read}`, {
        params: { apikey: this.auth.key() },
      })
      .pipe(
        map((res) => {
          if (bucket === 'watched' && res?.episodes) {
            for (const entry of res.episodes) {
              const ep = entry.episode;
              const showId = ep?.show?.ids?.tmdb;
              const season = ep?.season;
              const episode = ep?.number;
              if (showId && typeof season === 'number' && typeof episode === 'number') {
                this.watchedEpisodes.add(`${showId}:${season}:${episode}`);
              }
            }
          }
          const set = new Set(collectTmdbIds(res));
          this.members.set(bucket, set);
          this.watchedVersion.update((v) => v + 1);
          return set;
        }),
        catchError((err) => {
          console.warn(`Failed to fetch ${bucket} bucket:`, err);
          return of(this.members.get(bucket) ?? new Set<number>());
        }),
      );
  }
}

/** The nested title object `/sync/*` wraps a movie or show entry in. */
interface BucketTitle {
  title?: string;
  year?: number;
  ids?: { imdb?: string; tmdb?: number; trakt?: number; tvdb?: number; mdblist?: string };
  poster?: string;
  runtime?: number;
}

/**
 * `/watchlist/items` returns items directly (the title fields sit on the
 * entry itself), while the `/sync/*` reads wrap each one in `{movie: {...}}`
 * / `{show: {...}}` alongside a timestamp — `BucketEntry` extends
 * `BucketTitle` so a flat entry can be read as its own title.
 */
interface BucketEntry extends BucketTitle {
  id?: number;
  movie?: BucketTitle;
  show?: BucketTitle;
  /** `sync/watched` only — what `recentlyWatchedMovies()` sorts by. */
  last_watched_at?: string | null;
}

interface BucketEpisode {
  season?: number;
  number?: number;
  ids?: { tmdb?: number; tvdb?: number };
  show?: BucketTitle;
}

interface BucketEpisodeEntry {
  last_watched_at?: string | null;
  episode?: BucketEpisode;
}

interface BucketResponse {
  movies?: BucketEntry[];
  shows?: BucketEntry[];
  seasons?: unknown[];
  episodes?: BucketEpisodeEntry[];
}

function collectTmdbIds(res: BucketResponse): number[] {
  const movieAndShowIds = [...(res?.movies ?? []), ...(res?.shows ?? [])]
    .map((entry) => entry.movie?.ids?.tmdb ?? entry.show?.ids?.tmdb ?? entry.ids?.tmdb ?? entry.id)
    .filter((id): id is number => typeof id === 'number');

  const episodeShowIds = (res?.episodes ?? [])
    .map((entry) => entry.episode?.show?.ids?.tmdb)
    .filter((id): id is number => typeof id === 'number');

  return Array.from(new Set([...movieAndShowIds, ...episodeShowIds]));
}

function fromBucketEntry(entry: BucketEntry): MdbItem | null {
  const title = entry.movie ?? entry;
  const tmdbId = title.ids?.tmdb ?? entry.id;
  if (!tmdbId) return null;

  return {
    id: tmdbId,
    mediatype: 'movie',
    imdb_id: title.ids?.imdb ?? null,
    ids: title.ids ?? {},
    title: title.title || translate('Untitled'),
    language: '',
    country: '',
    release_year: title.year ?? null,
    release_date: null,
    runtime: title.runtime ?? null,
    // Raw mdblist URL, same convention as every other `MdbItem` source —
    // `MediaCard` is what upscales it for the size it actually needs.
    poster: title.poster ?? null,
    genre: null,
    rank: null,
  };
}
