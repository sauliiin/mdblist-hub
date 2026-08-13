import { Injectable, inject, signal } from '@angular/core';
import { tmdbImg } from './api.config';
import { MediaType, TmdbLogo } from './models';
import { TmdbService } from './tmdb.service';

/**
 * Resolves real landscape art for Primefly cards — never a cropped portrait
 * poster, matching the native apps' own rule ("never crop a portrait poster
 * into a landscape card", `PosterCard.kt`). Unlike the native pipeline this
 * skips Fanart.tv and a persistent cache: a session-lived `Map` plus TMDB's
 * own `images.backdrops` is enough for the web, where every card already
 * pays for one TMDB `detail()` call anyway (the hero and continue-watching
 * rows do the same). Callers request lazily — see `MediaCard`'s
 * IntersectionObserver — so a shelf of 30 cards costs TMDB calls only for
 * the handful actually scrolled into view, the closest web equivalent of
 * Compose's LazyRow only composing what's on screen.
 */
@Injectable({ providedIn: 'root' })
export class LandscapeArtworkService {
  private readonly tmdb = inject(TmdbService);

  private readonly cache = new Map<string, string | null>();
  private readonly pending = new Set<string>();
  /** Bumped on every resolution so `get()` stays reactive inside `computed()`/`effect()`. */
  private readonly version = signal(0);

  /** The cached URL, `null` if TMDB has nothing usable, `undefined` if never requested. */
  get(type: MediaType, id: number): string | null | undefined {
    this.version();
    return this.cache.get(key(type, id));
  }

  /** Kicks off a TMDB lookup once per title; a no-op if already cached or in flight. */
  request(type: MediaType, id: number): void {
    const k = key(type, id);
    if (this.cache.has(k) || this.pending.has(k)) return;
    this.pending.add(k);

    this.tmdb.detail(type, id).subscribe((detail) => {
      this.pending.delete(k);
      this.cache.set(k, pickLandscape(detail?.images?.backdrops));
      this.version.update((v) => v + 1);
    });
  }
}

function key(type: MediaType, id: number): string {
  return `${type}:${id}`;
}

/**
 * Mirrors native's `bestTmdbLandscape`: a language-tagged backdrop (one that
 * carries the title's own treatment art, not a plain scenery shot) beats an
 * untagged one, Portuguese preferred over English, highest-voted within a
 * language. `null` when TMDB has nothing tagged — Fanart.tv is native's next
 * fallback there, deliberately skipped here (see the class doc comment).
 */
function pickLandscape(backdrops: TmdbLogo[] | undefined): string | null {
  if (!backdrops?.length) return null;

  for (const lang of ['pt', 'en']) {
    const best = backdrops
      .filter((b) => b.iso_639_1 === lang)
      .sort((a, b) => b.vote_average - a.vote_average)[0];
    if (best) return tmdbImg(best.file_path, 'w780');
  }

  return null;
}
