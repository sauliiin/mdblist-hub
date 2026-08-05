import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { upscalePoster } from '../../core/api.config';
import { MdbItem, toTmdbType } from '../../core/models';
import { TvService } from '../../core/tv/tv.service';

@Component({
  selector: 'app-media-card',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
  styleUrl: './media-card.scss',
})
export class MediaCard {
  private readonly tv = inject(TvService);

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
  protected readonly runtime = computed(() => {
    const minutes = this.item().runtime;
    if (!minutes) return null;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}min` : `${m}min`;
  });
}
