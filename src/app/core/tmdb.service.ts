import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of } from 'rxjs';
import { API } from './api.config';
import {
  GenreOption, MediaType, TmdbDetail, TmdbGenre, TmdbKeyword, TmdbPerson, TmdbReview,
  TmdbSearchResult, toTmdbType,
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

  /**
   * The genre vocabulary, merged across movies and shows. The same genre has
   * different ids in each catalogue, so both are kept per name.
   */
  genres(): Observable<GenreOption[]> {
    return forkJoin({
      movie: this.genreList('movie', 'pt-BR'),
      tv: this.genreList('tv', 'pt-BR'),
      // The English names double as the mdblist genre slugs.
      movieEn: this.genreList('movie', 'en-US'),
      tvEn: this.genreList('tv', 'en-US'),
    }).pipe(
      map(({ movie, tv, movieEn, tvEn }) => {
        const slugs = new Map<number, string>();
        for (const genre of [...movieEn, ...tvEn]) {
          slugs.set(genre.id, genre.name.toLowerCase());
        }

        const merged = new Map<string, GenreOption>();
        for (const genre of movie) {
          merged.set(genre.name, {
            name: genre.name,
            slug: slugs.get(genre.id) ?? genre.name.toLowerCase(),
            movieId: genre.id,
            tvId: null,
          });
        }
        for (const genre of tv) {
          const existing = merged.get(genre.name);
          if (existing) existing.tvId = genre.id;
          else
            merged.set(genre.name, {
              name: genre.name,
              slug: slugs.get(genre.id) ?? genre.name.toLowerCase(),
              movieId: null,
              tvId: genre.id,
            });
        }

        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      }),
    );
  }

  /** Browses a whole genre, most popular first. */
  discover(tmdbType: 'movie' | 'tv', genreId: number): Observable<TmdbSearchResult[]> {
    return this.discoverBy(tmdbType, { with_genres: genreId });
  }

  /**
   * Titles tagged with a thematic keyword (e.g. "zombie", "female assassin"),
   * as opposed to genre or free-text search.
   */
  discoverByKeyword(tmdbType: 'movie' | 'tv', keywordId: number): Observable<TmdbSearchResult[]> {
    return this.discoverBy(tmdbType, { with_keywords: keywordId });
  }

  private discoverBy(
    tmdbType: 'movie' | 'tv',
    filter: Record<string, number>,
  ): Observable<TmdbSearchResult[]> {
    return this.http
      .get<{ results: TmdbSearchResult[] }>(`${API.tmdb.base}/discover/${tmdbType}`, {
        params: {
          api_key: API.tmdb.key,
          language: 'pt-BR',
          include_adult: 'false',
          sort_by: 'popularity.desc',
          'vote_count.gte': 40,
          ...filter,
        },
      })
      .pipe(
        // `discover` omits media_type; the endpoint already tells us what it is.
        map((res) => (res.results ?? []).map((r) => ({ ...r, media_type: tmdbType }))),
        catchError(() => of([])),
      );
  }

  /**
   * Looks up TMDB's keyword tags (e.g. "zombie", "time travel", "female
   * assassin"). These are English-only and matched by TMDB's own fuzzy text
   * index — a Portuguese phrase typically won't hit unless it happens to
   * coincide with an English tag.
   */
  searchKeywords(query: string): Observable<TmdbKeyword[]> {
    return this.http
      .get<{ results: TmdbKeyword[] }>(`${API.tmdb.base}/search/keyword`, {
        params: { api_key: API.tmdb.key, query },
      })
      .pipe(
        map((res) => res.results ?? []),
        catchError(() => of([])),
      );
  }

  private genreList(tmdbType: 'movie' | 'tv', language: string): Observable<TmdbGenre[]> {
    return this.http
      .get<{ genres: TmdbGenre[] }>(`${API.tmdb.base}/genre/${tmdbType}/list`, {
        params: { api_key: API.tmdb.key, language },
      })
      .pipe(
        map((res) => res.genres ?? []),
        catchError(() => of([])),
      );
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
