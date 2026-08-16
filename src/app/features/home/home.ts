import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  Observable, debounceTime, distinctUntilChanged, forkJoin, map, of, switchMap, tap,
} from 'rxjs';
import { tmdbImg, upscalePoster } from '../../core/api.config';
import { AuthService } from '../../core/auth.service';
import { CatalogPrefsService } from '../../core/catalog-prefs.service';
import { I18nPipe, I18nService } from '../../core/i18n.service';
import { applyPrefs } from '../../core/list-catalog';
import { ListPrefsService } from '../../core/list-prefs.service';
import { MdblistService } from '../../core/mdblist.service';
import {
  COLLECTION_PREF_ID, GenreOption, GridItem, MdbItem, MdbList, RawAddonCatalog, TmdbKeyword,
  TmdbSearchResult, WATCHLIST_PREF_ID, catalogKey, formatYear, toTmdbType,
} from '../../core/models';
import { AddonsService } from '../../core/stremio/addons.service';
import { ThemePrefsService } from '../../core/theme-prefs.service';
import { TmdbService } from '../../core/tmdb.service';
import { TvService } from '../../core/tv/tv.service';
import { MediaRow } from '../../ui/media-row/media-row';
import { BecauseYouWatched } from './because-you-watched/because-you-watched';
import { CatalogRow } from './catalog-row/catalog-row';
import { ContinueWatching } from './continue-watching/continue-watching';
import { Hero } from './hero/hero';
import { LibraryRow } from './library-row/library-row';
import { RecentlyWatched } from './recently-watched/recently-watched';

type Filter = 'all' | 'movie' | 'show';

/** `MDBLIST_CATALOG_HOST` — mirrors the constant of the same name in the native repo's `HomeScreen.kt`. */
const MDBLIST_CATALOG_HOST = 'stremio-mdblist.baby-beamup.club';

/**
 * One row on the home page, whatever backs it — a custom mdblist list, one
 * of the two built-in buckets, or one catalog a Stremio addon declares.
 * `id`/`name` are what `applyPrefs()` needs to hide/rename/reorder every row
 * through the same mechanism, `MediaRow`/`LibraryRow`/`CatalogRow` included.
 * A catalog's `id` is a string (`catalogKey()`) rather than `MdbList.id`'s
 * number — it has no id of its own, only a position inside a manifest.
 *
 * `atTop`/`atBottom` are relative to the row's own reorder group (built-ins,
 * custom lists, addon catalogs — see `curated()`), not to its position in
 * the page overall: a custom list's up-arrow has to disable exactly when
 * `moveList()`'s own neighbour swap, scoped to that same group, would have
 * nowhere to go, and that stopped being "first/last in `visible()`" the
 * moment the three groups stopped sharing one order.
 */
type HomeRowBase =
  | { kind: 'watchlist' | 'collection'; id: number; name: string }
  | { kind: 'list'; id: number; name: string; list: MdbList }
  | { kind: 'catalog'; id: string; name: string; catalog: RawAddonCatalog };

/** `HomeRowBase`, plus each row's position within its own reorder group — see the doc comment above. */
type HomeRow = HomeRowBase & { atTop: boolean; atBottom: boolean };

/** Tags each row with its position within its own array — see `HomeRow`'s `atTop`/`atBottom`. */
function withEdges<T extends HomeRowBase>(rows: T[]): (T & { atTop: boolean; atBottom: boolean })[] {
  return rows.map((row, i) => ({ ...row, atTop: i === 0, atBottom: i === rows.length - 1 }));
}

interface Criteria {
  query: string;
  genre: string;
  kind: Filter;
}

/** Text search results plus, when the query also matched a TMDB keyword tag. */
interface SearchOutcome {
  items: GridItem[];
  keyword: string | null;
}

@Component({
  selector: 'app-home',
  imports: [
    DecimalPipe, I18nPipe, RouterLink, BecauseYouWatched, CatalogRow, ContinueWatching, Hero, LibraryRow, MediaRow,
    RecentlyWatched,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  private readonly mdblist = inject(MdblistService);
  protected readonly tv = inject(TvService);
  private readonly tmdb = inject(TmdbService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly listPrefs = inject(ListPrefsService);
  protected readonly catalogPrefs = inject(CatalogPrefsService);
  private readonly addons = inject(AddonsService);
  protected readonly theme = inject(ThemePrefsService).themeKey;
  protected readonly i18n = inject(I18nService);

  protected readonly lists = signal<MdbList[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly query = signal('');
  protected readonly filter = signal<Filter>('all');
  /** Selected genre name; empty means "every genre". */
  protected readonly genre = signal('');
  protected readonly searching = signal(false);
  protected readonly formatYear = formatYear;

  /** Toggles the rename/hide/reorder controls on each row's heading. */
  protected readonly editMode = signal(false);

  /** The two built-in rows, before rename/hide/reorder — see `HomeRow`. */
  private readonly libraryRows = computed<HomeRowBase[]>(() => [
    { kind: 'watchlist', id: WATCHLIST_PREF_ID, name: this.i18n.t('Watchlist') },
    { kind: 'collection', id: COLLECTION_PREF_ID, name: this.i18n.t('Collection') },
  ]);

  /**
   * Every catalog an installed addon declares, minus the ones this same
   * account's mdblist lists already cover. Some addons — mdblist's own
   * Stremio catalog bridge chief among them — exist purely to mirror an
   * mdblist list into the Stremio protocol for clients with no native
   * mdblist integration; this app already shows that same list directly
   * (`this.lists()`), so showing the bridge's copy too would be the same row
   * twice. Mirrors the native apps' `HomeScreen.extraCatalogs`/
   * `mdblistMirrorListId()` exactly, including the URL shape it parses.
   */
  private readonly addonCatalogRows = computed<HomeRowBase[]>(() => {
    const mirroredListIds = new Set(this.lists().map((list) => list.id));
    return this.addons
      .catalogs()
      .filter((catalog) => {
        const listId = mdblistMirrorListId(catalog.addonBase);
        return listId === null || !mirroredListIds.has(listId);
      })
      .map((catalog): HomeRowBase => {
        const id = catalogKey(catalog);
        return { kind: 'catalog', id, name: catalog.originalName, catalog };
      });
  });

  /**
   * Rename/hide/reorder applied within each group — three separate
   * `applyPrefs()` calls, concatenated built-ins, then custom lists, then
   * addon catalogs, rather than one shared order. Watchlist and Coleção are
   * the rows someone coming back wants right after Continuar assistindo; a
   * single shared order let a custom list's saved `position` (from moving it
   * up in edit mode) sort it ahead of them, which is what running everything
   * through one `applyPrefs()` used to allow. Addon catalogs get their own
   * group for the same reason, one level down — a catalog reordered against
   * other catalogs never bleeds into where a custom list sits.
   */
  protected readonly curated = computed<HomeRow[]>(() => {
    const listPrefs = this.listPrefs.all();
    const library = withEdges(applyPrefs<HomeRowBase>(this.libraryRows(), listPrefs));
    const custom = withEdges(
      applyPrefs<HomeRowBase>(
        this.lists().map((list): HomeRowBase => ({ kind: 'list', id: list.id, name: list.name, list })),
        listPrefs,
      ),
    );
    const catalogs = withEdges(
      applyPrefs<HomeRowBase>(this.addonCatalogRows(), this.catalogPrefs.all()),
    );
    return [...library, ...custom, ...catalogs];
  });

  protected readonly genres = toSignal(this.tmdb.genres(), {
    initialValue: [] as GenreOption[],
  });

  /** A query or a genre swaps the list rows for a grid of results. */
  protected readonly browseMode = computed(
    () => this.query().trim().length >= 2 || !!this.genre(),
  );

  private readonly criteria = computed<Criteria>(() => ({
    query: this.query().trim(),
    genre: this.genre(),
    kind: this.filter(),
  }));

  private readonly outcome = toSignal(
    toObservable(this.criteria).pipe(
      debounceTime(300),
      distinctUntilChanged(
        (a, b) => a.query === b.query && a.genre === b.genre && a.kind === b.kind,
      ),
      tap((c) => this.searching.set(c.query.length >= 2 || !!c.genre)),
      switchMap((c) => this.fetch(c)),
      tap(() => this.searching.set(false)),
    ),
    { initialValue: { items: [], keyword: null } as SearchOutcome },
  );

  protected readonly results = computed(() => this.outcome().items);
  /** The keyword tag the query also matched, e.g. "zombie" — null otherwise. */
  protected readonly matchedKeyword = computed(() => this.outcome().keyword);

  /** The grid also honours the Filmes/Séries toggle. */
  protected readonly visibleResults = computed(() => {
    const kind = this.filter();
    const wanted = kind === 'movie' ? 'movie' : kind === 'show' ? 'tv' : null;
    const results = this.results();
    return wanted ? results.filter((r) => r.tmdbType === wanted) : results;
  });

  protected readonly resultsLabel = computed(() => {
    const query = this.query().trim();
    const genre = this.genre();
    if (query && genre) return this.i18n.t('“{query}” in {genre}, in your lists', { query, genre });
    if (genre) return this.i18n.t('{genre}, in your lists', { genre });
    return this.i18n.t('“{query}” in the TMDB catalog', { query });
  });

  /**
   * The Filmes/Séries toggle means something for a custom list or an addon
   * catalog — each declares its own kind — but not for the built-in rows,
   * always shown regardless.
   */
  protected readonly visible = computed(() => {
    const kind = this.filter();
    if (kind === 'all') return this.curated();

    return this.curated().filter((row) => {
      if (row.kind === 'list') return row.list.mediatype === kind || row.list.mediatype === null;
      if (row.kind === 'catalog') return (row.catalog.type === 'series' ? 'show' : 'movie') === kind;
      return true;
    });
  });

  /** Custom-list items only — the built-in rows were never part of this count. */
  protected readonly totalItems = computed(() =>
    this.curated().reduce((sum, row) => sum + (row.kind === 'list' ? row.list.items : 0), 0),
  );

  constructor() {
    this.mdblist.lists().subscribe({
      next: (lists) => {
        this.lists.set(lists);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  /**
   * A genre always means "inside my lists" — it scans every curated list and
   * matches mdblist's own genre tags, narrowed further by the text if any.
   *
   * Plain text searches the TMDB catalogue two ways at once: by title, and by
   * matching a TMDB keyword tag (e.g. "zombie", "time travel", "female
   * assassin") — which additionally surfaces titles that never mention the
   * word but are thematically tagged with it. Keyword tags are English-only
   * and matched by TMDB's own fuzzy index, so a Portuguese phrase typically
   * won't hit one unless it happens to coincide with an English tag.
   */
  private fetch(criteria: Criteria): Observable<SearchOutcome> {
    if (criteria.genre) {
      const slug = this.genres().find((g) => g.name === criteria.genre)?.slug;
      if (!slug) return of({ items: [], keyword: null });
      const needle = criteria.query.toLowerCase();

      return this.mdblist.allItems().pipe(
        map((items) => ({
          items: items
            .filter((item) => (item.genre ?? []).includes(slug))
            .filter((item) => !needle || item.title.toLowerCase().includes(needle))
            .map(fromMdbItem),
          keyword: null,
        })),
      );
    }

    if (criteria.query.length >= 2) {
      return forkJoin({
        titles: this.tmdb.search(criteria.query),
        keywords: this.tmdb.searchKeywords(criteria.query),
      }).pipe(
        switchMap(({ titles, keywords }) => {
          const keyword = bestKeyword(keywords, criteria.query);
          if (!keyword) return of({ titles, keyword: null as TmdbKeyword | null });

          return forkJoin([
            this.tmdb.discoverByKeyword('movie', keyword.id),
            this.tmdb.discoverByKeyword('tv', keyword.id),
          ]).pipe(
            map(([movies, shows]) => ({ titles: [...titles, ...movies, ...shows], keyword })),
          );
        }),
        map(({ titles, keyword }) => ({
          items: dedupeResults(titles).map((result) => fromTmdb(result, this.i18n.t('Untitled'))),
          keyword: keyword?.name ?? null,
        })),
      );
    }

    return of({ items: [], keyword: null });
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onGenre(event: Event): void {
    this.genre.set((event.target as HTMLSelectElement).value);
  }

  protected clearAll(): void {
    this.query.set('');
    this.genre.set('');
  }

  /** Way out of a key that stopped working mid-session. */
  protected reauth(): void {
    this.auth.signOut();
    this.router.navigate(['/login']);
  }

  protected toggleEditMode(): void {
    this.editMode.update((v) => !v);
  }

  protected renameList(id: number, name: string): void {
    this.listPrefs.rename(id, name);
  }

  /** The trash button's confirm step — see `MediaRow.confirmDelete`. No undo UI yet: a hidden row just stops rendering. */
  protected deleteList(id: number): void {
    this.listPrefs.hide(id);
  }

  /**
   * The neighbour swap needs the ids exactly as they're currently displayed
   * — filtered to the built-in/custom-list group specifically, not the whole
   * `curated()` array: an addon catalog's id is a string, `ListPrefsService`
   * only ever deals in numbers, and the two groups are separately positioned
   * anyway (see `curated()`), so a catalog id in this order would be both a
   * type error and meaningless to `ListPrefsService.move()`.
   */
  protected moveList(id: number, direction: -1 | 1): void {
    const order = this.curated()
      .filter((row): row is Extract<HomeRow, { id: number }> => row.kind !== 'catalog')
      .map((row) => row.id);
    this.listPrefs.move(id, direction, order);
  }

  protected renameCatalog(id: string, name: string): void {
    this.catalogPrefs.rename(id, name);
  }

  /** Only ever removes the row — see `deleteList`. The addon itself stays installed. */
  protected deleteCatalog(id: string): void {
    this.catalogPrefs.hide(id);
  }

  /** Same restriction as `moveList()`, mirrored: only the catalog group's own order. */
  protected moveCatalog(id: string, direction: -1 | 1): void {
    const order = this.curated()
      .filter((row): row is Extract<HomeRow, { kind: 'catalog' }> => row.kind === 'catalog')
      .map((row) => row.id);
    this.catalogPrefs.move(id, direction, order);
  }
}

/**
 * The source mdblist list id, only for manifests generated by mdblist's own
 * catalog bridge — see `addonCatalogRows()`. Its transport URL shape is
 * `…/unified/{listId}/{apiKey}/mdblist/manifest.json`; the id sits two
 * segments before the literal `mdblist` marker.
 */
function mdblistMirrorListId(addonBase: string): number | null {
  let url: URL;
  try {
    url = new URL(addonBase);
  } catch {
    return null;
  }
  if (!url.host.toLowerCase().includes(MDBLIST_CATALOG_HOST)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const marker = segments.lastIndexOf('mdblist');
  if (marker < 2) return null;

  const id = Number(segments[marker - 2]);
  return Number.isInteger(id) ? id : null;
}

/** Prefers an exact (case-insensitive) tag name over TMDB's fuzzy top hit. */
function bestKeyword(keywords: TmdbKeyword[], query: string): TmdbKeyword | null {
  if (!keywords.length) return null;
  const needle = query.trim().toLowerCase();
  return keywords.find((k) => k.name.toLowerCase() === needle) ?? keywords[0];
}

function dedupeResults(results: TmdbSearchResult[]): TmdbSearchResult[] {
  const seen = new Set<string>();
  const unique: TmdbSearchResult[] = [];

  for (const result of results) {
    const key = `${result.media_type}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }

  return unique;
}

function fromMdbItem(item: MdbItem): GridItem {
  return {
    key: `${item.mediatype}:${item.id}`,
    id: item.id,
    tmdbType: toTmdbType(item.mediatype),
    title: item.title,
    poster: upscalePoster(item.poster, 'w342'),
    // mdblist has no backdrop field at all — a genre-filtered result stays
    // portrait-only; see the `backdrop` doc comment on `GridItem`.
    backdrop: null,
    year: item.release_year ? String(item.release_year) : '',
    vote: null,
  };
}

function fromTmdb(result: TmdbSearchResult, untitled: string): GridItem {
  return {
    key: `${result.media_type}:${result.id}`,
    id: result.id,
    tmdbType: result.media_type === 'tv' ? 'tv' : 'movie',
    title: result.title || result.name || untitled,
    poster: tmdbImg(result.poster_path, 'w342'),
    // Free: TMDB's search/discover results already carry a backdrop, no
    // extra call needed the way `LandscapeArtworkService` costs one.
    backdrop: tmdbImg(result.backdrop_path, 'w780'),
    year: (result.release_date || result.first_air_date || '').slice(0, 4),
    vote: result.vote_average || null,
  };
}
