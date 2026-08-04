import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RatingBadge } from '../../core/models';

@Component({
  selector: 'app-rating-badges',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="badges">
      @for (badge of badges(); track badge.key) {
        <div class="badge" [attr.data-tone]="badge.tone" [title]="badge.label">
          <div class="ring" [style.--pct]="(badge.score ?? 0) + '%'">
            <span class="value">{{ badge.display }}</span>
          </div>
          <div class="text">
            <span class="label">{{ badge.label }}</span>
            @if (badge.votes) {
              <span class="votes">{{ badge.votes | number }} votos</span>
            }
          </div>
        </div>
      } @empty {
        <p class="none">Nenhuma nota disponível para este título.</p>
      }
    </div>
  `,
  styleUrl: './rating-badges.scss',
})
export class RatingBadges {
  readonly badges = input.required<RatingBadge[]>();
}
