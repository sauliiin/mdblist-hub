import { Injectable, inject } from '@angular/core';
import { MediaDetailService } from './media-detail.service';
import { MediaType } from './models';

/**
 * Aquece o cache HTTP antes da navegação: quando um card ganha foco (TV),
 * hover demorado (desktop) ou toque (mobile), o detalhe inteiro é buscado em
 * background. Abrir a página depois disso resolve tudo do cache — o
 * interceptor deduplica, então no pior caso a página só se pendura na
 * requisição que já está no ar.
 */
@Injectable({ providedIn: 'root' })
export class PrefetchService {
  private readonly detail = inject(MediaDetailService);

  /** Última vez que cada título foi aquecido, para não repetir em rajada. */
  private readonly warmed = new Map<string, number>();

  /** Mesma janela do cache em memória do interceptor. */
  private static readonly REWARM_MS = 10 * 60 * 1000;

  detailFor(type: MediaType, tmdbId: number): void {
    const key = `${type}:${tmdbId}`;
    const last = this.warmed.get(key);
    if (last && Date.now() - last < PrefetchService.REWARM_MS) return;
    this.warmed.set(key, Date.now());
    this.detail.load(type, tmdbId).subscribe({ error: () => {} });
  }
}
