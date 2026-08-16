import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of, switchMap } from 'rxjs';
import { API, tmdbImg } from './api.config';
import { tmdbLanguage, translate } from './i18n.service';
import { MdblistService } from './mdblist.service';
import { MdbItem, MediaType, TmdbRecommendation, toTmdbType } from './models';

/** The mdblist list that holds the viewing history. */
const HISTORY_LIST = 'Last Watched';
/** How far back the recommendations look. */
const WATCHED_WINDOW = 45;
/** How many "porque você assistiu" rows to build. */
const ROWS = 5;
const PER_ROW = 20;

export interface RecommendationRow {
  /** The watched title the row is based on. */
  seed: MdbItem;
  items: MdbItem[];
}

@Injectable({ providedIn: 'root' })
export class RecommendationsService {
  private readonly http = inject(HttpClient);
  private readonly mdblist = inject(MdblistService);

  /**
   * Builds rows of TMDB recommendations seeded from the watch history, skipping
   * anything already in it.
   *
   * By default the seeds are the five titles watched most recently, so the feed
   * follows what the account is actually watching now. `shuffle` re-rolls them
   * across the whole 45-title window instead, which is what the "outras
   * sugestões" button asks for.
   */
  becauseYouWatched(shuffle = false): Observable<RecommendationRow[]> {
    return this.watched().pipe(
      switchMap((watched) => {
        const usable = watched.filter((item) => item.poster);
        if (!usable.length) return of([]);

        const seen = new Set(usable.map((item) => key(item)));
        const seeds = shuffle ? sample(usable, ROWS) : usable.slice(0, ROWS);

        return forkJoin(seeds.map((seed) => this.rowFor(seed, seen)));
      }),
      map((rows) => rows.filter((row) => row.items.length >= 4)),
    );
  }

  /**
   * The watch history, newest first.
   *
   * "Last Watched" is the list mdblist keeps in sync with the account's own
   * history, and it already comes back in watch order — the explicit sort on
   * `rank` only makes that guarantee ours rather than the API's, since the
   * "five most recent" above now depends on it.
   */
  watched(limit = WATCHED_WINDOW): Observable<MdbItem[]> {
    return this.mdblist.listByName(HISTORY_LIST).pipe(
      switchMap((list) => (list ? this.mdblist.listItems(list.id, limit) : of([]))),
      map((items) => [...items].sort((a, b) => rank(a) - rank(b))),
    );
  }

  private rowFor(seed: MdbItem, alreadyWatched: Set<string>): Observable<RecommendationRow> {
    const tmdbType = toTmdbType(seed.mediatype);

    return this.http
      .get<{ results: TmdbRecommendation[] }>(
        `${API.tmdb.base}/${tmdbType}/${seed.id}/recommendations`,
        { params: { api_key: API.tmdb.key, language: tmdbLanguage() } },
      )
      .pipe(
        map((res) => {
          const items = (res.results ?? [])
            .filter((rec) => rec.poster_path)
            .map((rec) => toItem(rec, seed.mediatype))
            .filter((item) => !alreadyWatched.has(key(item)))
            .slice(0, PER_ROW);

          return { seed, items };
        }),
        // A seed with no recommendations yields an empty row, dropped upstream.
        map((row) => row),
      );
  }
}

/** Adapts a TMDB recommendation to the shape the card component renders. */
function toItem(rec: TmdbRecommendation, fallbackType: MediaType): MdbItem {
  const type: MediaType = rec.media_type
    ? rec.media_type === 'tv'
      ? 'show'
      : 'movie'
    : fallbackType;
  const date = rec.release_date || rec.first_air_date || null;

  return {
    id: rec.id,
    mediatype: type,
    imdb_id: null,
    ids: { tmdb: rec.id },
    title: rec.title || rec.name || translate('Untitled'),
    language: '',
    country: '',
    release_year: date ? Number(date.slice(0, 4)) : null,
    release_date: date,
    runtime: null,
    poster: tmdbImg(rec.poster_path, 'w342'),
    genre: null,
    rank: null,
  };
}

function key(item: MdbItem): string {
  return `${item.mediatype}:${item.id}`;
}

/** Position in the list — 1 is the most recent. Unranked items sink. */
function rank(item: MdbItem): number {
  return item.rank ?? Number.MAX_SAFE_INTEGER;
}

/** Picks `count` distinct entries at random. */
function sample<T>(items: T[], count: number): T[] {
  const pool = [...items];
  const picked: T[] = [];

  while (pool.length && picked.length < count) {
    picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }

  return picked;
}
