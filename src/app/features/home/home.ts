import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  Observable, debounceTime, distinctUntilChanged, forkJoin, map, of, switchMap, tap,
} from 'rxjs';
import { tmdbImg, upscalePoster } from '../../core/api.config';
import { AuthService } from '../../core/auth.service';
import { applyPrefs } from '../../core/list-catalog';
import { ListPrefsService } from '../../core/list-prefs.service';
import { MdblistService } from '../../core/mdblist.service';
import {
  GenreOption, GridItem, MdbItem, MdbList, TmdbKeyword, TmdbSearchResult, formatYear,
  toTmdbType,
} from '../../core/models';
import { ThemePrefsService } from '../../core/theme-prefs.service';
import { TmdbService } from '../../core/tmdb.service';
import { TvService } from '../../core/tv/tv.service';
import { MediaRow } from '../../ui/media-row/media-row';
import { BecauseYouWatched } from './because-you-watched/because-you-watched';
import { ContinueWatching } from './continue-watching/continue-watching';
import { Hero } from './hero/hero';

type Filter = 'all' | 'movie' | 'show';

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
  imports: [DecimalPipe, RouterLink, BecauseYouWatched, ContinueWatching, Hero, MediaRow],
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
  protected readonly theme = inject(ThemePrefsService).themeKey;

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

  /** Rename/hide/reorder applied on top of the fetched lists, hidden ones dropped. */
  protected readonly curated = computed(() => applyPrefs(this.lists(), this.listPrefs.all()));
  /**
   * Same, but keeping hidden rows in — otherwise edit mode would have no way
   * to reach a hidden list to un-hide it again.
   */
  protected readonly curatedForEditing = computed(() =>
    applyPrefs(this.lists(), this.listPrefs.all(), { includeHidden: true }),
  );
  protected readonly hiddenIds = computed(
    () => new Set(this.listPrefs.all().filter((p) => p.hidden).map((p) => p.id)),
  );

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
    if (query && genre) return `“${query}” em ${genre}, nas suas listas`;
    if (genre) return `${genre}, nas suas listas`;
    return `“${query}” no catálogo do TMDB`;
  });

  protected readonly visible = computed(() => {
    const kind = this.filter();
    const source = this.editMode() ? this.curatedForEditing() : this.curated();
    return source.filter((l) => kind === 'all' || l.mediatype === kind || l.mediatype === null);
  });

  protected readonly totalItems = computed(() =>
    this.curated().reduce((sum, l) => sum + l.items, 0),
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
          items: dedupeResults(titles).map(fromTmdb),
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

  protected toggleListHidden(id: number): void {
    if (this.hiddenIds().has(id)) this.listPrefs.show(id);
    else this.listPrefs.hide(id);
  }

  /** The neighbour swap needs the ids exactly as edit mode is showing them, hidden ones included. */
  protected moveList(id: number, direction: -1 | 1): void {
    this.listPrefs.move(id, direction, this.curatedForEditing().map((l) => l.id));
  }
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

function fromTmdb(result: TmdbSearchResult): GridItem {
  return {
    key: `${result.media_type}:${result.id}`,
    id: result.id,
    tmdbType: result.media_type === 'tv' ? 'tv' : 'movie',
    title: result.title || result.name || 'Sem título',
    poster: tmdbImg(result.poster_path, 'w342'),
    // Free: TMDB's search/discover results already carry a backdrop, no
    // extra call needed the way `LandscapeArtworkService` costs one.
    backdrop: tmdbImg(result.backdrop_path, 'w780'),
    year: (result.release_date || result.first_air_date || '').slice(0, 4),
    vote: result.vote_average || null,
  };
}
