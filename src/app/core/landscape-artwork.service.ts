import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { API, tmdbImg } from './api.config';
import { currentLanguage } from './i18n.service';
import { FanartImage, FanartResponse, MediaType, TmdbLogo } from './models';
import { TmdbService } from './tmdb.service';

/**
 * Resolves real landscape art for Primefly cards — never a cropped portrait
 * poster, matching the native apps' own rule ("never crop a portrait poster
 * into a landscape card", `PosterCard.kt`). Mirrors native's fallback chain
 * exactly (`MediaRepository.resolveLandscapeArtwork`): a language-tagged TMDB
 * backdrop, then Fanart.tv's purpose-made thumb, then TMDB's plain backdrop,
 * and finally Fanart.tv's generic background — each tier only queried once
 * the one before it comes back empty. Session-lived only (a plain `Map`, no
 * persistent cache): the web build already pays for one TMDB `detail()` call
 * per card anyway (the hero and continue-watching rows do the same), so
 * there is nothing to save by caching across reloads the way native's Room
 * table does.
 */
@Injectable({ providedIn: 'root' })
export class LandscapeArtworkService {
  private readonly http = inject(HttpClient);
  private readonly tmdb = inject(TmdbService);

  private readonly cache = new Map<string, string | null>();
  private readonly pending = new Set<string>();
  /** Bumped on every resolution so `get()` stays reactive inside `computed()`/`effect()`. */
  private readonly version = signal(0);

  /** The cached URL, `null` if nothing usable turned up anywhere, `undefined` if never requested. */
  get(type: MediaType, id: number): string | null | undefined {
    this.version();
    return this.cache.get(key(type, id));
  }

  /** Kicks off resolution once per title; a no-op if already cached or in flight. */
  request(type: MediaType, id: number): void {
    const k = key(type, id);
    if (this.cache.has(k) || this.pending.has(k)) return;
    this.pending.add(k);

    this.tmdb.detail(type, id).subscribe((detail) => {
      const tmdbLandscape = pickLandscape(detail?.images?.backdrops);
      const tmdbBackdrop = tmdbImg(detail?.backdrop_path, 'w780');
      // Fanart.tv keys films by TMDB id, but series by TVDB id.
      const fanartId = type === 'show' ? detail?.external_ids?.tvdb_id : id;

      if (tmdbLandscape || !fanartId || fanartId <= 0) {
        this.resolve(k, tmdbLandscape ?? tmdbBackdrop);
        return;
      }

      this.fanartArt(type, fanartId).subscribe((art) => {
        this.resolve(k, tmdbLandscape ?? art.thumb ?? tmdbBackdrop ?? art.background);
      });
    });
  }

  private resolve(k: string, url: string | null): void {
    this.pending.delete(k);
    this.cache.set(k, url);
    this.version.update((v) => v + 1);
  }

  /** One call covers both fallback tiers — Fanart's response already carries thumb and background together. */
  private fanartArt(type: MediaType, fanartId: number): Observable<{ thumb: string | null; background: string | null }> {
    const segment = type === 'show' ? 'tv' : 'movies';
    return this.http
      .get<FanartResponse>(`${API.fanart.base}/${segment}/${fanartId}`, {
        params: { api_key: API.fanart.key },
      })
      .pipe(
        map((res) => ({
          thumb: bestFanartUrl(type === 'show' ? res.tvthumb : res.moviethumb),
          background: bestFanartUrl(type === 'show' ? res.showbackground : res.moviebackground),
        })),
        catchError(() => of({ thumb: null, background: null })),
      );
  }
}

function key(type: MediaType, id: number): string {
  return `${type}:${id}`;
}

/**
 * Mirrors native's `bestTmdbLandscape`: a language-tagged backdrop (one that
 * carries the title's own treatment art, not a plain scenery shot) beats an
 * untagged one, Portuguese preferred over English, highest-voted within a
 * language. `null` when TMDB has nothing tagged.
 */
function pickLandscape(backdrops: TmdbLogo[] | undefined): string | null {
  if (!backdrops?.length) return null;

  for (const lang of currentLanguage() === 'pt' ? ['pt', 'en'] : ['en', 'pt']) {
    const best = backdrops
      .filter((b) => b.iso_639_1 === lang)
      .sort((a, b) => b.vote_average - a.vote_average)[0];
    if (best) return tmdbImg(best.file_path, 'w780');
  }

  return null;
}

/** Mirrors native's `bestFanartUrl`: most-liked entry with a real URL. */
function bestFanartUrl(images: FanartImage[] | undefined): string | null {
  if (!images?.length) return null;

  return (
    images
      .filter((i) => i.url?.startsWith('http'))
      .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))[0]?.url ?? null
  );
}
