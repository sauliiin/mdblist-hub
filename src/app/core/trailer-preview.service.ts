import { Injectable, inject, signal } from '@angular/core';
import { MediaType } from './models';
import { TmdbService } from './tmdb.service';

/**
 * Resolves the same trailer a title's detail page would open, but for the
 * Netflix-style hover preview on a card — see `MediaCard`. A separate cache
 * from `LandscapeArtworkService` on purpose: that one only matters under
 * Primefly, this one works under every theme, and coupling the two would
 * make a plain hover pay for backdrop art it never shows. The one call this
 * costs (`tmdb.detail`) only fires once the 2s dwell actually elapses, not
 * on every card the pointer happens to cross.
 */
@Injectable({ providedIn: 'root' })
export class TrailerPreviewService {
  private readonly tmdb = inject(TmdbService);

  private readonly cache = new Map<string, string | null>();
  private readonly pending = new Set<string>();
  /** Bumped on every resolution so `get()` stays reactive inside `computed()`. */
  private readonly version = signal(0);

  /** The cached YouTube key, `null` if the title has none, `undefined` if never requested. */
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
      this.cache.set(k, pickTrailer(detail?.videos?.results));
      this.version.update((v) => v + 1);
    });
  }
}

function key(type: MediaType, id: number): string {
  return `${type}:${id}`;
}

/** Same rule the detail page's own trailer button uses — see `media-detail.service.ts`. */
function pickTrailer(
  videos: { key: string; site: string; type: string; official: boolean }[] | undefined,
): string | null {
  if (!videos?.length) return null;
  const official = videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official);
  return (official ?? videos.find((v) => v.site === 'YouTube'))?.key ?? null;
}
