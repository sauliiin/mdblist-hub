import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, tap } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { API } from './api.config';
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

  constructor() {
    // Another account has another watchlist, collection and history.
    effect(() => {
      this.auth.key();
      this.members.clear();
    });
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
      catchError(() => of({ watchlist: false, watched: false, collection: false })),
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
        }),
      );
  }

  /**
   * Movies mdblist has marked watched, most recent first — the same
   * `sync/watched` bucket `ids()` reads for membership below, just with the
   * `append_to_response` extras a real row needs (poster, title, year).
   *
   * Deliberately not the "Last Watched" list `RecommendationsService`
   * already seeds "Porque você assistiu" from: the native apps' own doc
   * comments flag that list as only existing for accounts with Trakt/Simkl
   * synced through mdblist, and switch to this exact bucket instead for
   * that reason — same call made here, for the same reason.
   */
  recentlyWatchedMovies(limit = 30): Observable<MdbItem[]> {
    return this.entries('watched', limit).pipe(
      map((entries) =>
        entries
          // mdblist's own ordering here isn't guaranteed — sorted explicitly,
          // the same defensive call the native apps' repository makes.
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

  private ids(bucket: Bucket): Observable<Set<number>> {
    const cached = this.members.get(bucket);
    if (cached) return of(cached);

    return this.http
      .get<BucketResponse>(`${API.mdblist.base}${ROUTES[bucket].read}`, {
        params: { apikey: this.auth.key() },
      })
      .pipe(
        map((res) => {
          const set = new Set(collectTmdbIds(res));
          this.members.set(bucket, set);
          return set;
        }),
        catchError(() => of(new Set<number>())),
      );
  }
}

/** The nested title object `/sync/*` wraps a movie or show entry in. */
interface BucketTitle {
  title?: string;
  year?: number;
  ids?: { imdb?: string; tmdb?: number };
  poster?: string;
  runtime?: number;
}

/**
 * `/watchlist/items` returns items directly, while the `/sync/*` reads wrap
 * each one in `{movie: {...}}` / `{show: {...}}` alongside a timestamp.
 */
interface BucketEntry {
  id?: number;
  ids?: { tmdb?: number };
  movie?: BucketTitle;
  show?: BucketTitle;
  /** `sync/watched` only — what `recentlyWatchedMovies()` sorts by. */
  last_watched_at?: string | null;
}

interface BucketResponse {
  movies?: BucketEntry[];
  shows?: BucketEntry[];
}

function collectTmdbIds(res: BucketResponse): number[] {
  return [...(res?.movies ?? []), ...(res?.shows ?? [])]
    .map((entry) => entry.movie?.ids?.tmdb ?? entry.show?.ids?.tmdb ?? entry.ids?.tmdb ?? entry.id)
    .filter((id): id is number => typeof id === 'number');
}

function fromBucketEntry(entry: BucketEntry): MdbItem | null {
  const title = entry.movie;
  const tmdbId = title?.ids?.tmdb;
  if (!title || !tmdbId) return null;

  return {
    id: tmdbId,
    mediatype: 'movie',
    imdb_id: title.ids?.imdb ?? null,
    ids: title.ids ?? {},
    title: title.title || 'Sem título',
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
