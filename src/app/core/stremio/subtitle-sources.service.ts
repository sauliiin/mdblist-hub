import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Observable, catchError, forkJoin, map, of } from 'rxjs';
import { API } from '../api.config';
import { noCache } from '../http-cache.interceptor';
import { SubtitleOption } from './models';
import { languageLabel, toBcp47 } from './subtitles';

const OPENSUBTITLES_FILE_SCHEME = 'opensubtitles-file:';

interface OpenSubtitlesSearch {
  data?: OpenSubtitlesItem[];
}

interface OpenSubtitlesItem {
  attributes?: {
    language?: string;
    release?: string;
    download_count?: number;
    files?: { file_id: number; file_name?: string }[];
  };
}

interface WyzieItem {
  id?: string | number;
  url?: string;
  encoding?: string;
  release?: string;
  fileName?: string;
  downloadCount?: number;
}

/** Direct subtitle catalogs that complement installed Stremio addons. */
@Injectable({ providedIn: 'root' })
export class SubtitleSourcesService {
  private readonly http = inject(HttpClient);
  private readonly native = Capacitor.isNativePlatform();
  private readonly openSubtitlesBase = this.native
    ? API.openSubtitles.base
    : API.openSubtitles.webProxy;

  /** Searches all direct sources independently, so one outage never hides the others. */
  search(id: string): Observable<SubtitleOption[]> {
    const parsed = parseStremioId(id);
    if (!parsed) return of([]);

    return forkJoin([
      this.openSubtitlesSearch(parsed),
      this.wyzieSearch(parsed, 'pb', 'pob'),
      this.wyzieSearch(parsed, 'pt', 'por'),
      this.wyzieSearch(parsed, 'en', 'eng'),
    ]).pipe(map((results) => results.flat()));
  }

  /** Resolves quota-bearing OpenSubtitles file ids only for the chosen track. */
  resolveUrl(option: SubtitleOption): Observable<string> {
    if (!option.url.startsWith(OPENSUBTITLES_FILE_SCHEME)) return of(option.url);

    const fileId = Number(option.url.slice(OPENSUBTITLES_FILE_SCHEME.length));
    if (!Number.isSafeInteger(fileId)) throw new Error('Invalid OpenSubtitles file id');

    return this.http
      .post<{ link?: string }>(
        `${this.openSubtitlesBase}/download`,
        { file_id: fileId },
        { headers: this.openSubtitlesHeaders(), context: noCache() },
      )
      .pipe(
        map((response) => {
          if (!response.link) throw new Error('OpenSubtitles returned no download link');
          return response.link;
        }),
      );
  }

  private openSubtitlesSearch(id: ParsedStremioId): Observable<SubtitleOption[]> {
    const params: Record<string, string | number> = {};
    // OpenSubtitles canonicalizes both zero-padded ids and query ordering with
    // a relative redirect. Sending its canonical form up front matters behind
    // the same-origin web proxy, where that redirect would escape the route.
    if (id.episode != null) params['episode_number'] = id.episode;
    params['imdb_id'] = id.imdbId.replace(/^0+/, '') || '0';
    params['languages'] = 'pt-br,pt,en';
    params['order_by'] = 'download_count';
    params['order_direction'] = 'desc';
    if (id.season != null) params['season_number'] = id.season;
    params['type'] = id.season == null ? 'movie' : 'episode';

    return this.http
      .get<OpenSubtitlesSearch>(`${this.openSubtitlesBase}/subtitles`, {
        params,
        headers: this.openSubtitlesHeaders(),
        context: noCache(),
      })
      .pipe(
        map((response) =>
          (response.data ?? [])
            .map((item) => openSubtitlesOption(item))
            .filter((option): option is SubtitleOption => option !== null),
        ),
        catchError(() => of([])),
      );
  }

  private wyzieSearch(
    id: ParsedStremioId,
    requestedLanguage: string,
    normalizedLanguage: string,
  ): Observable<SubtitleOption[]> {
    const params: Record<string, string | number> = {
      id: `tt${id.imdbId}`,
      language: requestedLanguage,
      key: API.wyzie.key,
    };
    if (id.season != null) params['season'] = id.season;
    if (id.episode != null) params['episode'] = id.episode;

    return this.http
      .get<WyzieItem[]>(`${API.wyzie.base}/search`, {
        params,
        context: noCache(),
      })
      .pipe(
        map((response) =>
          response
            .map((item, index) => wyzieOption(item, index, normalizedLanguage))
            .filter((option): option is SubtitleOption => option !== null),
        ),
        catchError(() => of([])),
      );
  }

  private openSubtitlesHeaders(): HttpHeaders {
    let headers = new HttpHeaders({ 'Api-Key': API.openSubtitles.key });
    // `User-Agent` is forbidden to browser JavaScript. CapacitorHttp can send
    // it natively; on the web the same-origin proxy supplies its own agent.
    if (this.native) headers = headers.set('User-Agent', API.openSubtitles.userAgent);
    return headers;
  }
}

interface ParsedStremioId {
  imdbId: string;
  season: number | null;
  episode: number | null;
}

function parseStremioId(id: string): ParsedStremioId | null {
  const [imdb, seasonText, episodeText] = id.split(':');
  const imdbId = imdb?.replace(/^tt/, '');
  if (!imdbId || !/^\d+$/.test(imdbId)) return null;

  return {
    imdbId,
    season: seasonText == null ? null : Number(seasonText),
    episode: episodeText == null ? null : Number(episodeText),
  };
}

function openSubtitlesOption(item: OpenSubtitlesItem): SubtitleOption | null {
  const attributes = item.attributes;
  const file = attributes?.files?.[0];
  const lang = attributes?.language?.trim();
  if (!file || !lang) return null;

  return {
    key: `opensubtitles.com#${file.file_id}`,
    addon: 'OpenSubtitles.com',
    label: languageLabel(lang),
    lang,
    srclang: toBcp47(lang),
    url: `${OPENSUBTITLES_FILE_SCHEME}${file.file_id}`,
    encoding: null,
    releaseHint: attributes?.release || file.file_name || null,
    popularity: attributes?.download_count ?? 0,
  };
}

function wyzieOption(item: WyzieItem, index: number, lang: string): SubtitleOption | null {
  const url = item.url?.trim();
  if (!url) return null;

  return {
    key: `wyzie#${lang}#${item.id ?? index}`,
    addon: 'Wyzie',
    label: languageLabel(lang),
    lang,
    srclang: toBcp47(lang),
    url,
    encoding: item.encoding ?? null,
    releaseHint: item.release || item.fileName || null,
    popularity: item.downloadCount ?? 0,
  };
}
