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

  ngOnInit(): void {
    this.load();
  }

  /** Re-rolls the seeds, giving a different feed on demand. */
  protected load(): void {
    this.loading.set(true);
    this.recommendations.becauseYouWatched().subscribe((rows) => {
      this.rows.set(rows);
      this.loading.set(false);
    });
  }
}
