import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of, switchMap } from 'rxjs';
import { API, tmdbImg } from './api.config';
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
   * Builds rows of TMDB recommendations seeded by titles picked at random from
   * the last 45 watched, skipping anything already in the history. The picks
   * are re-rolled on every load, which is what keeps the feed dynamic.
   */
  becauseYouWatched(): Observable<RecommendationRow[]> {
    return this.watched().pipe(
      switchMap((watched) => {
        const usable = watched.filter((item) => item.poster);
        if (!usable.length) return of([]);

        const seen = new Set(usable.map((item) => key(item)));
        const seeds = sample(usable, ROWS);

        return forkJoin(seeds.map((seed) => this.rowFor(seed, seen)));
      }),
      map((rows) => rows.filter((row) => row.items.length >= 4)),
    );
  }

  /** The most recently watched titles, newest first. */
  watched(limit = WATCHED_WINDOW): Observable<MdbItem[]> {
    return this.mdblist.listByName(HISTORY_LIST).pipe(
      switchMap((list) => (list ? this.mdblist.listItems(list.id, limit) : of([]))),
    );
  }

  private rowFor(seed: MdbItem, alreadyWatched: Set<string>): Observable<RecommendationRow> {
    const tmdbType = toTmdbType(seed.mediatype);

    return this.http
      .get<{ results: TmdbRecommendation[] }>(
        `${API.tmdb.base}/${tmdbType}/${seed.id}/recommendations`,
        { params: { api_key: API.tmdb.key, language: 'pt-BR' } },
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
    title: rec.title || rec.name || 'Sem título',
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

/** Picks `count` distinct entries at random. */
function sample<T>(items: T[], count: number): T[] {
  const pool = [...items];
  const picked: T[] = [];

  while (pool.length && picked.length < count) {
    picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }

  return picked;
}
