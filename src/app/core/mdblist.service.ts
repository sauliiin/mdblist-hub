import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
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
    return this.http
      .get<MdbList[]>(`${API.mdblist.base}/lists/user`, { params: { apikey: API.mdblist.key } })
      .pipe(map((lists) => curate(lists.filter((l) => l.items > 0))));
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
