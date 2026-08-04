import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { API } from './api.config';
import {
  MediaType, TmdbDetail, TmdbPerson, TmdbReview, TmdbSearchResult, toTmdbType,
} from './models';

@Injectable({ providedIn: 'root' })
export class TmdbService {
  private readonly http = inject(HttpClient);

  /** Full record plus credits, external ids, trailers and recommendations. */
  detail(type: MediaType, tmdbId: number): Observable<TmdbDetail | null> {
    const tmdbType = toTmdbType(type);
    const append =
      tmdbType === 'tv'
        ? 'aggregate_credits,external_ids,videos,recommendations'
        : 'credits,external_ids,videos,recommendations';

    return this.http
      .get<TmdbDetail>(`${API.tmdb.base}/${tmdbType}/${tmdbId}`, {
        params: { api_key: API.tmdb.key, append_to_response: append },
      })
      .pipe(catchError(() => of(null)));
  }

  /** One of the two review sources merged on the detail page. */
  reviews(type: MediaType, tmdbId: number): Observable<TmdbReview[]> {
    return this.http
      .get<{ results: TmdbReview[] }>(`${API.tmdb.base}/${toTmdbType(type)}/${tmdbId}/reviews`, {
        params: { api_key: API.tmdb.key },
      })
      .pipe(
        map((res) => res.results ?? []),
        catchError(() => of([])),
      );
  }

  /** Person record, with the IMDb id Wikidata can be looked up by. */
  person(personId: number): Observable<TmdbPerson | null> {
    return this.http
      .get<TmdbPerson>(`${API.tmdb.base}/person/${personId}`, {
        params: {
          api_key: API.tmdb.key,
          language: 'pt-BR',
          append_to_response: 'external_ids,combined_credits',
        },
      })
      .pipe(catchError(() => of(null)));
  }

  /** Free-text search across movies and shows. */
  search(query: string): Observable<TmdbSearchResult[]> {
    return this.http
      .get<{ results: TmdbSearchResult[] }>(`${API.tmdb.base}/search/multi`, {
        params: {
          api_key: API.tmdb.key,
          language: 'pt-BR',
          include_adult: 'false',
          query,
        },
      })
      .pipe(
        map((res) =>
          (res.results ?? []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv'),
        ),
        catchError(() => of([])),
      );
  }
}
