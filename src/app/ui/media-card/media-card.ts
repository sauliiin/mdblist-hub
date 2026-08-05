import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { upscalePoster } from '../../core/api.config';
import { MdbItem, toTmdbType } from '../../core/models';

@Component({
  selector: 'app-media-card',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
  styleUrl: './media-card.scss',
})
export class MediaCard {
  readonly item = input.required<MdbItem>();
  /** Position in the row, rendered as a rank chip. */
  readonly index = input<number | null>(null);

  protected readonly poster = computed(() => upscalePoster(this.item().poster, 'w342'));
  protected readonly link = computed(() => ['/title', toTmdbType(this.item().mediatype), this.item().id]);
  protected readonly genres = computed(() => (this.item().genre ?? []).slice(0, 2));
  protected readonly runtime = computed(() => {
    const minutes = this.item().runtime;
    if (!minutes) return null;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}min` : `${m}min`;
  });
}
