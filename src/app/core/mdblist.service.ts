import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, switchMap } from 'rxjs';
import { API } from './api.config';
import { curate } from './list-catalog';
import { MdbInfo, MdbItem, MdbList, MediaType } from './models';

@Injectable({ providedIn: 'root' })
export class MdblistService {
  private readonly http = inject(HttpClient);

  /**
   * The curated lists: only the catalogued ones, renamed to Portuguese and
   * sorted alphabetically.
   */
  lists(): Observable<MdbList[]> {
    return this.allLists().pipe(map(curate));
  }

  /**
   * Every non-empty list, catalogued or not. The recommendations feed reads
   * "Last Watched" through here, which `curate()` deliberately hides.
   */
  allLists(): Observable<MdbList[]> {
    return this.http
      .get<MdbList[]>(`${API.mdblist.base}/lists/user`, { params: { apikey: API.mdblist.key } })
      .pipe(map((lists) => lists.filter((l) => l.items > 0)));
  }

  /** Looks a list up by its exact mdblist name, case-insensitively. */
  listByName(name: string): Observable<MdbList | null> {
    const needle = name.trim().toLowerCase();
    return this.allLists().pipe(
      map((lists) => lists.find((l) => l.name.trim().toLowerCase() === needle) ?? null),
    );
  }

  /**
   * Items of a list. `unified=true` flattens movies and shows into a single
   * array, which matters for the mixed-media lists.
   */
  listItems(listId: number, limit = 40, offset = 0): Observable<MdbItem[]> {
    return this.http
      .get<MdbItem[]>(`${API.mdblist.base}/lists/${listId}/items`, {
        params: {
          apikey: API.mdblist.key,
          unified: 'true',
          append_to_response: 'poster,genre',
          limit,
          offset,
        },
      })
      .pipe(
        map((items) => (Array.isArray(items) ? items : [])),
        catchError(() => of([])),
      );
  }

  /**
   * Every item across the curated lists, deduplicated. Backs the genre filter,
   * which searches the user's own lists rather than the TMDB catalogue. The
   * requests are cached by the HTTP interceptor, so switching genres after the
   * first load hits no network.
   */
  allItems(perList = 200): Observable<MdbItem[]> {
    return this.lists().pipe(
      switchMap((lists) =>
        lists.length
          ? forkJoin(lists.map((list) => this.listItems(list.id, perList)))
          : of<MdbItem[][]>([]),
      ),
      map((pages) => {
        const seen = new Set<string>();
        const items: MdbItem[] = [];

        for (const item of pages.flat()) {
          const key = `${item.mediatype}:${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(item);
        }

        return items;
      }),
    );
  }

  /**
   * Aggregated ratings for one title (IMDb, Rotten Tomatoes, Metacritic,
   * Trakt, Letterboxd, TMDB, Roger Ebert...) keyed by TMDB id, plus the
   * reviews mdblist mirrors from Trakt and TMDB.
   */
  info(type: MediaType, tmdbId: number): Observable<MdbInfo | null> {
    return this.http
      .get<MdbInfo>(`${API.mdblist.base}/tmdb/${type}/${tmdbId}`, {
        params: { apikey: API.mdblist.key, append_to_response: 'review' },
      })
      .pipe(catchError(() => of(null)));
  }
}
