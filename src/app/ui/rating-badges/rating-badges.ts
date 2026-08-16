import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RatingBadge } from '../../core/models';
import { I18nPipe } from '../../core/i18n.service';

@Component({
  selector: 'app-rating-badges',
  imports: [DecimalPipe, I18nPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="badges">
      @for (badge of badges(); track badge.key) {
        <div class="badge" [attr.data-tone]="badge.tone" [title]="badge.label">
          <div class="ring" [style.--pct]="(badge.score ?? 0) + '%'">
            <span class="value">{{ badge.display }}</span>
          </div>
          <div class="text">
            <span class="label">{{ badge.label | i18n }}</span>
            @if (badge.votes) {
              <span class="votes">{{ badge.votes | number }} {{ 'votes' | i18n }}</span>
            }
          </div>
        </div>
      } @empty {
        <p class="none">{{ 'No ratings available for this title.' | i18n }}</p>
      }
    </div>
  `,
  styleUrl: './rating-badges.scss',
})
export class RatingBadges {
  readonly badges = input.required<RatingBadge[]>();
}
