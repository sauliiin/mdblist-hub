import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { LibraryService } from '../../../core/library.service';
import { MdbItem } from '../../../core/models';
import { MediaCard } from '../../../ui/media-card/media-card';

/**
 * "Watchlist" or "Coleção" straight out of mdblist's own buckets — separate
 * from the account's custom lists, so `MediaRow`'s list-fetch path does not
 * apply here. Same shelf shape as `RecentlyWatched`, parameterised by bucket
 * so both rows share one component instead of two near-duplicates.
 */
@Component({
  selector: 'app-library-row',
  imports: [MediaCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-row.html',
  styleUrl: './library-row.scss',
})
export class LibraryRow implements OnInit {
  private readonly library = inject(LibraryService);

  readonly bucket = input.required<'watchlist' | 'collection'>();
  readonly heading = input.required<string>();
  readonly subheading = input.required<string>();

  protected readonly items = signal<MdbItem[]>([]);
  protected readonly loading = signal(true);

  ngOnInit(): void {
    const movies$ =
      this.bucket() === 'watchlist' ? this.library.watchlistMovies(30) : this.library.collectionMovies(30);

    movies$.subscribe((items) => {
      this.items.set(items);
      this.loading.set(false);
    });
  }
}
