import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { LibraryService } from '../../../core/library.service';
import { I18nPipe } from '../../../core/i18n.service';
import { MdbItem } from '../../../core/models';
import { MediaCard } from '../../../ui/media-card/media-card';

/**
 * "Watchlist" or "Coleção" straight out of mdblist's own buckets — separate
 * from the account's custom lists, so `MediaRow`'s list-fetch path does not
 * apply here. Same shelf shape as `RecentlyWatched`, parameterised by bucket
 * so both rows share one component instead of two near-duplicates.
 *
 * `editMode`/`rename`/`delete`/`moveUp`/`moveDown` mirror `MediaRow`'s own
 * exactly — `Home` now runs both kinds of row through the same shared,
 * interleaved order (see `HomeRow` there), so they need the same controls.
 */
@Component({
  selector: 'app-library-row',
  imports: [I18nPipe, MediaCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library-row.html',
  styleUrl: './library-row.scss',
})
export class LibraryRow implements OnInit {
  private readonly library = inject(LibraryService);

  readonly bucket = input.required<'watchlist' | 'collection'>();
  readonly heading = input.required<string>();
  readonly subheading = input.required<string>();
  readonly editMode = input(false);
  /** Disables the respective reorder arrow when this row is at that edge. */
  readonly atTop = input(false);
  readonly atBottom = input(false);

  readonly rename = output<string>();
  /** Confirmed via the trash button's own popover — see `confirmDelete`. */
  readonly delete = output<void>();
  readonly moveUp = output<void>();
  readonly moveDown = output<void>();

  protected readonly items = signal<MdbItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly renaming = signal(false);
  protected readonly draftName = signal('');
  /** The trash button's own confirm step — see `askDelete`. */
  protected readonly confirmingDelete = signal(false);

  ngOnInit(): void {
    const movies$ =
      this.bucket() === 'watchlist' ? this.library.watchlistMovies(30) : this.library.collectionMovies(30);

    movies$.subscribe((items) => {
      this.items.set(items);
      this.loading.set(false);
    });
  }

  protected startRename(): void {
    this.draftName.set(this.heading());
    this.renaming.set(true);
  }

  protected confirmRename(): void {
    const name = this.draftName().trim();
    this.renaming.set(false);
    if (name && name !== this.heading()) this.rename.emit(name);
  }

  protected cancelRename(): void {
    this.renaming.set(false);
  }

  protected onDraftName(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  protected askDelete(): void {
    this.confirmingDelete.set(true);
  }

  protected cancelDelete(): void {
    this.confirmingDelete.set(false);
  }

  protected confirmDelete(): void {
    this.confirmingDelete.set(false);
    this.delete.emit();
  }
}
