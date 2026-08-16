import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { LibraryService } from '../../../core/library.service';
import { I18nPipe } from '../../../core/i18n.service';
import { MdbItem } from '../../../core/models';
import { MediaCard } from '../../../ui/media-card/media-card';

/**
 * "Assistidos recentemente" — straight out of mdblist's `sync/watched`
 * bucket, movies only. Sits between the list rows and "Porque você
 * assistiu", which is itself seeded by watch history but built as
 * recommendations rather than the history itself.
 */
@Component({
  selector: 'app-recently-watched',
  imports: [I18nPipe, MediaCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recently-watched.html',
  styleUrl: './recently-watched.scss',
})
export class RecentlyWatched implements OnInit {
  private readonly library = inject(LibraryService);

  protected readonly items = signal<MdbItem[]>([]);
  protected readonly loading = signal(true);

  ngOnInit(): void {
    this.library.recentlyWatchedMovies(30).subscribe((items) => {
      this.items.set(items);
      this.loading.set(false);
    });
  }
}
