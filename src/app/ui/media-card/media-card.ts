import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { upscalePoster } from '../../core/api.config';
import { MdbItem, toTmdbType } from '../../core/models';
import { PrefetchService } from '../../core/prefetch.service';
import { TvService } from '../../core/tv/tv.service';

@Component({
  selector: 'app-media-card',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
  styleUrl: './media-card.scss',
})
export class MediaCard implements OnDestroy {
  private readonly tv = inject(TvService);
  private readonly prefetch = inject(PrefetchService);

  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly item = input.required<MdbItem>();
  /** Position in the row, rendered as a rank chip. */
  readonly index = input<number | null>(null);

  /*
   * `w342` (342px wide) is sized for the ~230px cards on desktop. On TV the
   * card is now ~113–179px (see `media-row.scss`), so that file is 2–3× more
   * pixels than ever get painted — real bytes over the wire and real decode
   * work for a weak set-top CPU, for detail nobody sees. `w185` matches what
   * the TV card actually needs.
   */
  protected readonly poster = computed(() =>
    upscalePoster(this.item().poster, this.tv.isTv() ? 'w185' : 'w342'),
  );
  protected readonly link = computed(() => ['/title', toTmdbType(this.item().mediatype), this.item().id]);
  protected readonly genres = computed(() => (this.item().genre ?? []).slice(0, 2));

  protected readonly imdbRating = computed(() => {
    const value = this.item().ratings?.find((r) => r.source === 'imdb')?.value;
    return typeof value === 'number' ? value : null;
  });

  /*
   * Prefetch do detalhe: foco (D-pad na TV) e hover armam um timer curto —
   * só quem *para* num card dispara, não a varredura a caminho de outro.
   * Toque dispara na hora: encostar o dedo já é intenção de abrir.
   */
  protected armPrefetch(): void {
    if (this.prefetchTimer !== null) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.prefetchNow();
    }, 200);
  }

  protected cancelPrefetch(): void {
    if (this.prefetchTimer === null) return;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
  }

  protected prefetchNow(): void {
    this.cancelPrefetch();
    this.prefetch.detailFor(this.item().mediatype, this.item().id);
  }

  ngOnDestroy(): void {
    this.cancelPrefetch();
  }
}
