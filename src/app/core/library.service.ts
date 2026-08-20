import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { EMPTY, Observable, catchError, expand, forkJoin, map, of, reduce, tap } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { API } from './api.config';
import { translate } from './i18n.service';
import { AuthService } from './auth.service';
import { LibraryProviderService } from './library-provider.service';
import { MdbItem, MediaType } from './models';
import { TraktService } from './trakt/trakt.service';

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

/**
 * Entries per bucket request. mdblist counts films, series, seasons and
 * episodes together against this, and honours it up to a thousand.
 */
const BUCKET_PAGE = 1000;

/** A stop, not a target: bounds a huge history at a few thousand entries. */
const BUCKET_MAX_PAGES = 5;

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly trakt = inject(TraktService);
  private readonly provider = inject(LibraryProviderService);

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
    // Another account has another watchlist, collection and history — and so
    // does another *provider*: without this, a title on the mdblist watchlist
    // would keep showing as watchlisted under a Trakt account that never
    // heard of it.
    effect(() => {
      const key = this.auth.key();
      this.provider.provider();
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

    const write$ = this.provider.usingTrakt()
      ? this.trakt.write(bucket, target, add)
      : this.http
          .post<unknown>(`${WRITE_BASE}${route}`, body, {
            params: { apikey: this.auth.key() },
          })
          .pipe(map(() => add));

    return write$.pipe(
      tap((state) => {
        const set = this.members.get(bucket);
        if (!set) return;
        state ? set.add(target.tmdbId) : set.delete(target.tmdbId);
        this.watchedVersion.update((v) => v + 1);
      }),
    );
  }

  /**
   * Titles marked watched (movies and shows), most recent first.
   */
  recentlyWatchedMovies(limit = 30): Observable<MdbItem[]> {
    if (this.provider.usingTrakt()) return this.trakt.items('watched', limit);

    return this.http
      .get<BucketResponse | unknown[]>(`${API.mdblist.base}${ROUTES.watched.read}`, {
        params: {
          apikey: this.auth.key(),
          limit: limit * 2,
          append_to_response: 'poster,ratings',
        },
      })
      .pipe(
        map((res) => {
          if (Array.isArray(res)) {
            return deduplicateItems(
              res
                .map(fromUnifiedItem)
                .filter((item): item is MdbItem => item !== null),
            ).slice(0, limit);
          }

          const bucketRes = res as BucketResponse;
          const movieEntries = (bucketRes?.movies ?? []).map((m) => ({
            item: fromBucketEntry(m, 'movie'),
            time: m.last_watched_at ?? '',
          }));
          const showEntries = (bucketRes?.shows ?? []).map((s) => ({
            item: fromBucketEntry(s, 'show'),
            time: s.last_watched_at ?? '',
          }));
          const episodeEntries = (bucketRes?.episodes ?? [])
            .filter((e) => !!e.episode?.show)
            .map((e) => ({
              item: fromBucketEntry(e.episode!.show!, 'show'),
              time: e.last_watched_at ?? '',
            }));

          const combined = [...movieEntries, ...showEntries, ...episodeEntries]
            .filter((e): e is { item: MdbItem; time: string } => e.item !== null)
            .sort((a, b) => b.time.localeCompare(a.time))
            .map((e) => e.item);

          return deduplicateItems(combined).slice(0, limit);
        }),
        catchError(() => of([])),
      );
  }

  /** Titles on the account's watchlist (movies and shows), in newest-first order. */
  watchlistMovies(limit = 30): Observable<MdbItem[]> {
    if (this.provider.usingTrakt()) return this.trakt.items('watchlist', limit);

    return this.http
      .get<BucketResponse | unknown[]>(`${API.mdblist.base}${ROUTES.watchlist.read}`, {
        params: {
          apikey: this.auth.key(),
          limit: Math.max(limit, 50),
          unified: true,
          sort: 'added',
          order: 'desc',
          append_to_response: 'poster,ratings',
        },
      })
      .pipe(
        map((res) => {
          if (Array.isArray(res)) {
            const mapped = res
              .map(fromUnifiedItem)
              .filter((item): item is MdbItem => item !== null);
            return deduplicateItems(mapped).slice(0, limit);
          }

          const bucketRes = res as BucketResponse;
          const movieEntries = (bucketRes?.movies ?? []).map((m) => fromBucketEntry(m, 'movie'));
          const showEntries = (bucketRes?.shows ?? []).map((s) => fromBucketEntry(s, 'show'));
          const combined = [...movieEntries, ...showEntries].filter((i): i is MdbItem => i !== null);
          return deduplicateItems(combined).slice(0, limit);
        }),
        catchError(() => of([])),
      );
  }

  /** Titles in the account's collection (movies and shows), in newest-first order. */
  collectionMovies(limit = 30): Observable<MdbItem[]> {
    if (this.provider.usingTrakt()) return this.trakt.items('collection', limit);

    return this.http
      .get<BucketResponse | unknown[]>(`${API.mdblist.base}${ROUTES.collection.read}`, {
        params: {
          apikey: this.auth.key(),
          limit: limit * 2,
          unified: true,
          append_to_response: 'poster,ratings',
        },
      })
      .pipe(
        map((res) => {
          if (Array.isArray(res)) {
            const mapped = res
              .map(fromUnifiedItem)
              .filter((item): item is MdbItem => item !== null);
            return deduplicateItems(mapped).slice(0, limit);
          }

          const bucketRes = res as BucketResponse;
          const movieEntries = (bucketRes?.movies ?? []).map((m) => fromBucketEntry(m, 'movie'));
          const showEntries = (bucketRes?.shows ?? []).map((s) => fromBucketEntry(s, 'show'));
          const combined = [...movieEntries, ...showEntries].filter((i): i is MdbItem => i !== null);
          return deduplicateItems(combined).slice(0, limit);
        }),
        catchError(() => of([])),
      );
  }

  ids(bucket: Bucket): Observable<Set<number>> {
    const cached = this.members.get(bucket);
    if (cached) return of(cached);

    return this.provider.usingTrakt() ? this.traktIds(bucket) : this.mdblistIds(bucket);
  }

  /**
   * The same three buckets read from Trakt. A null answer means there was no
   * account to ask — an unlinked token, not an empty library — so whatever is
   * cached stays as it is rather than being replaced by nothing.
   */
  private traktIds(bucket: Bucket): Observable<Set<number>> {
    return this.trakt.membership(bucket).pipe(
      map((membership) => {
        if (!membership) return this.members.get(bucket) ?? new Set<number>();

        if (bucket === 'watched') {
          this.watchedEpisodes.clear();
          for (const key of membership.episodeKeys) this.watchedEpisodes.add(key);
        }

        const set = new Set(membership.titleIds);
        this.members.set(bucket, set);
        this.watchedVersion.update((v) => v + 1);
        return set;
      }),
    );
  }

  /**
   * A bucket read to the end, not just its first page.
   *
   * mdblist paginates all three: without asking for the rest, an account with
   * any real history gets back its most recent hundred entries and nothing
   * else — which showed as a series whose older episodes had lost their tick,
   * and a film in the collection whose button read "add".
   */
  private mdblistIds(bucket: Bucket): Observable<Set<number>> {
    const page = (cursor?: string) =>
      this.http.get<BucketResponse | unknown[]>(`${API.mdblist.base}${ROUTES[bucket].read}`, {
        params: cursor
          ? { apikey: this.auth.key(), limit: BUCKET_PAGE, cursor }
          : { apikey: this.auth.key(), limit: BUCKET_PAGE },
      });

    return page().pipe(
      expand((res: BucketResponse | unknown[], index) => {
        if (Array.isArray(res)) return EMPTY;
        const next = (res as BucketResponse)?.pagination?.next_cursor;
        return (res as BucketResponse)?.pagination?.has_more && next && index + 2 <= BUCKET_MAX_PAGES
          ? page(next)
          : EMPTY;
      }),
      reduce((pages: (BucketResponse | unknown[])[], res) => [...pages, res], []),
      map((pages) => {
        const set = new Set<number>();

        for (const res of pages) {
          if (bucket === 'watched' && !Array.isArray(res)) {
            for (const entry of (res as BucketResponse)?.episodes ?? []) {
              const ep = entry.episode;
              const showId = ep?.show?.ids?.tmdb;
              const season = ep?.season;
              const episode = ep?.number;
              if (showId && typeof season === 'number' && typeof episode === 'number') {
                this.watchedEpisodes.add(`${showId}:${season}:${episode}`);
              }
            }
          }
          for (const id of collectTmdbIds(res)) set.add(id);
        }

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
  mediatype?: string;
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
  /** `next_cursor` is what the following page is asked for by. */
  pagination?: { has_more?: boolean; next_cursor?: string | null };
}

function deduplicateItems(items: MdbItem[]): MdbItem[] {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function fromUnifiedItem(raw: unknown): MdbItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, any>;
  const tmdbId = item['ids']?.tmdb ?? (typeof item['id'] === 'number' && item['id'] > 0 ? item['id'] : null);
  if (!tmdbId) return null;

  const isShow =
    item['mediatype'] === 'show' ||
    item['mediatype'] === 'tv' ||
    item['type'] === 'show' ||
    item['type'] === 'tv' ||
    !!item['show'];

  const titleStr = item['title'] || item['name'] || translate('Untitled');
  const releaseYear =
    item['release_year'] ??
    item['year'] ??
    (item['release_date'] ? Number(String(item['release_date']).slice(0, 4)) : null);

  return {
    id: tmdbId,
    mediatype: isShow ? 'show' : 'movie',
    imdb_id: item['imdb_id'] ?? item['ids']?.imdb ?? null,
    ids: item['ids'] ?? { tmdb: tmdbId, imdb: item['imdb_id'] },
    title: titleStr,
    language: item['language'] || '',
    country: item['country'] || '',
    release_year: releaseYear,
    release_date: item['release_date'] ?? null,
    runtime: item['runtime'] ?? null,
    poster: item['poster'] ?? null,
    genre: Array.isArray(item['genre']) ? item['genre'] : null,
    rank: item['rank'] ?? null,
    ratings: item['ratings'] ?? [],
  };
}

function fromBucketEntry(entry: BucketEntry | BucketTitle, fallbackType: MediaType = 'movie'): MdbItem | null {
  if (!entry) return null;
  const entryObj = entry as BucketEntry;
  const isShow =
    fallbackType === 'show' ||
    !!entryObj.show ||
    (entry as any).mediatype === 'show' ||
    (entry as any).type === 'show' ||
    (entry as any).type === 'tv';
  const title = entryObj.show ?? entryObj.movie ?? entry;
  const tmdbId =
    title.ids?.tmdb ??
    entryObj.ids?.tmdb ??
    (typeof (entry as any).id === 'number' && (entry as any).id > 0 ? (entry as any).id : null);
  if (!tmdbId) return null;

  const releaseYear = title.year ?? (entry as any).release_year ?? (entry as any).year ?? null;

  return {
    id: tmdbId,
    mediatype: isShow ? 'show' : 'movie',
    imdb_id: title.ids?.imdb ?? (entry as any).imdb_id ?? entryObj.ids?.imdb ?? null,
    ids: title.ids ?? entryObj.ids ?? { tmdb: tmdbId },
    title: title.title || (entry as any).title || translate('Untitled'),
    language: '',
    country: '',
    release_year: releaseYear,
    release_date: (entry as any).release_date ?? null,
    runtime: title.runtime ?? (entry as any).runtime ?? null,
    poster: title.poster ?? (entry as any).poster ?? null,
    genre: (entry as any).genre ?? null,
    rank: (entry as any).rank ?? null,
    ratings: (entry as any).ratings ?? [],
  };
}

function collectTmdbIds(res: BucketResponse | unknown[]): number[] {
  if (Array.isArray(res)) {
    return res
      .map((entry: any) => entry.ids?.tmdb ?? (typeof entry.id === 'number' ? entry.id : null))
      .filter((id): id is number => typeof id === 'number' && id > 0);
  }
  const bucketRes = res as BucketResponse;
  const movieAndShowIds = [...(bucketRes?.movies ?? []), ...(bucketRes?.shows ?? [])]
    .map((entry) => entry.movie?.ids?.tmdb ?? entry.show?.ids?.tmdb ?? entry.ids?.tmdb ?? entry.id)
    .filter((id): id is number => typeof id === 'number' && id > 0);

  const episodeShowIds = (bucketRes?.episodes ?? [])
    .map((entry) => entry.episode?.show?.ids?.tmdb)
    .filter((id): id is number => typeof id === 'number' && id > 0);

  return Array.from(new Set([...movieAndShowIds, ...episodeShowIds]));
}
