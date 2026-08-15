import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { RawAddonCatalog, toTmdbType } from '../../../core/models';
import { CatalogItem } from '../../../core/stremio/models';
import { StremioService } from '../../../core/stremio/stremio.service';
import { TmdbService } from '../../../core/tmdb.service';

/**
 * One catalog a Stremio addon declares, rendered as a shelf — the web
 * counterpart of the native apps' `AddonCatalogRow` (`HomeScreen.kt`).
 *
 * Same row chrome as `LibraryRow`/`MediaRow` (rename/hide/reorder), but its
 * own card rather than `app-media-card`: a catalog meta typically carries
 * only an IMDb id, and `MediaCard` is built around `MdbItem`, whose `id` is
 * a *resolved* TMDB id used for both its route and its landscape-art lookup.
 * Resolving eagerly for a whole row would mean a TMDB request per poster to
 * draw a row nobody may open — see `open()`.
 */
@Component({
  selector: 'app-catalog-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './catalog-row.html',
  styleUrl: './catalog-row.scss',
})
export class CatalogRow implements OnInit {
  private readonly stremio = inject(StremioService);
  private readonly tmdb = inject(TmdbService);
  private readonly router = inject(Router);

  readonly catalog = input.required<RawAddonCatalog>();
  readonly heading = input.required<string>();
  readonly editMode = input(false);
  /** Disables the respective reorder arrow when this row is at that edge. */
  readonly atTop = input(false);
  readonly atBottom = input(false);

  readonly rename = output<string>();
  /** Confirmed via the trash button's own popover — see `confirmDelete`. */
  readonly delete = output<void>();
  readonly moveUp = output<void>();
  readonly moveDown = output<void>();

  protected readonly items = signal<CatalogItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly renaming = signal(false);
  protected readonly draftName = signal('');
  /** The trash button's own confirm step — see `askDelete`. */
  protected readonly confirmingDelete = signal(false);
  /** The one item currently being resolved by IMDb id — see `open()`. */
  protected readonly resolving = signal<string | null>(null);

  ngOnInit(): void {
    this.stremio.catalog(this.catalog()).subscribe((items) => {
      this.items.set(items);
      this.loading.set(false);
    });
  }

  /**
   * Every route in this app is TMDB-keyed, but the common Stremio catalog
   * gives only an IMDb id — resolved here, on the actual click, rather than
   * for the whole row up front. Matches the native apps' own
   * `HomeScreen.openCatalogItem`, down to resolving lazily for the same
   * reason: most of a row is never clicked.
   */
  protected open(item: CatalogItem): void {
    if (item.tmdbId) {
      this.router.navigate(['/title', item.tmdbType, item.tmdbId]);
      return;
    }
    if (!item.imdbId || this.resolving()) return;

    this.resolving.set(item.key);
    this.tmdb.findByImdb(item.imdbId).subscribe((resolved) => {
      this.resolving.set(null);
      if (resolved) this.router.navigate(['/title', toTmdbType(resolved.type), resolved.tmdbId]);
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
