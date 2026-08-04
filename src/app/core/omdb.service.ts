import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { API } from './api.config';
import { OmdbResponse } from './models';

export interface OmdbResult {
  data: OmdbResponse | null;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class OmdbService {
  private readonly http = inject(HttpClient);

  /** Awards, certification, box office and the IMDb/RT/Metacritic trio. */
  byImdb(imdbId: string): Observable<OmdbResult> {
    return this.http
      .get<OmdbResponse>(API.omdb.base, {
        params: { i: imdbId, apikey: API.omdb.key, plot: 'full' },
      })
      .pipe(
        map((data) =>
          data?.Response === 'True'
            ? { data, error: null }
            : { data: null, error: data?.Error ?? 'OMDb não retornou dados.' },
        ),
        catchError(() => of({ data: null, error: 'OMDb indisponível (cota diária ou rede).' })),
      );
  }
}
