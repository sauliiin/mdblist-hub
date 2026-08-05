import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RecommendationRow, RecommendationsService } from '../../../core/recommendations.service';
import { MediaCard } from '../../../ui/media-card/media-card';

@Component({
  selector: 'app-because-you-watched',
  imports: [MediaCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './because-you-watched.html',
  styleUrl: './because-you-watched.scss',
})
export class BecauseYouWatched implements OnInit {
  private readonly recommendations = inject(RecommendationsService);

  protected readonly rows = signal<RecommendationRow[]>([]);
  protected readonly loading = signal(true);
  /** False while the rows follow the history; true once the seeds are re-rolled. */
  protected readonly shuffled = signal(false);

  ngOnInit(): void {
    this.load(false);
  }

  /**
   * Loads the feed. Seeded by the five most recently watched titles, or — once
   * the visitor asks for other suggestions — by a random draw from the wider
   * history window.
   */
  protected load(shuffle: boolean): void {
    this.loading.set(true);
    this.shuffled.set(shuffle);

    this.recommendations.becauseYouWatched(shuffle).subscribe((rows) => {
      this.rows.set(rows);
      this.loading.set(false);
    });
  }
}
