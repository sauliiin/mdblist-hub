import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Observable, debounceTime, distinctUntilChanged, map, of, switchMap, tap } from 'rxjs';
import { tmdbImg, upscalePoster } from '../../core/api.config';
import { MdblistService } from '../../core/mdblist.service';
import {
  GenreOption, GridItem, MdbItem, MdbList, TmdbSearchResult, toTmdbType,
} from '../../core/models';
import { TmdbService } from '../../core/tmdb.service';
import { MediaRow } from '../../ui/media-row/media-row';
import { BecauseYouWatched } from './because-you-watched/because-you-watched';
import { Hero } from './hero/hero';

type Filter = 'all' | 'movie' | 'show';

interface Criteria {
  query: string;
  genre: string;
  kind: Filter;
}

@Component({
  selector: 'app-home',
  imports: [DecimalPipe, RouterLink, BecauseYouWatched, Hero, MediaRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  private readonly mdblist = inject(MdblistService);
  private readonly tmdb = inject(TmdbService);

  protected readonly lists = signal<MdbList[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly query = signal('');
  protected readonly filter = signal<Filter>('all');
  /** Selected genre name; empty means "every genre". */
  protected readonly genre = signal('');
  protected readonly searching = signal(false);

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

  protected readonly results = toSignal(
    toObservable(this.criteria).pipe(
      debounceTime(300),
      distinctUntilChanged(
        (a, b) => a.query === b.query && a.genre === b.genre && a.kind === b.kind,
      ),
      tap((c) => this.searching.set(c.query.length >= 2 || !!c.genre)),
      switchMap((c) => this.fetch(c)),
      tap(() => this.searching.set(false)),
    ),
    { initialValue: [] as GridItem[] },
  );

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
    return this.lists().filter(
      (l) => kind === 'all' || l.mediatype === kind || l.mediatype === null,
    );
  });

  protected readonly totalItems = computed(() =>
    this.lists().reduce((sum, l) => sum + l.items, 0),
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
   * Text on its own searches the whole TMDB catalogue instead.
   */
  private fetch(criteria: Criteria): Observable<GridItem[]> {
    if (criteria.genre) {
      const slug = this.genres().find((g) => g.name === criteria.genre)?.slug;
      if (!slug) return of([]);
      const needle = criteria.query.toLowerCase();

      return this.mdblist.allItems().pipe(
        map((items) =>
          items
            .filter((item) => (item.genre ?? []).includes(slug))
            .filter((item) => !needle || item.title.toLowerCase().includes(needle))
            .map(fromMdbItem),
        ),
      );
    }

    if (criteria.query.length >= 2) {
      return this.tmdb.search(criteria.query).pipe(map((results) => results.map(fromTmdb)));
    }

    return of([]);
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
}

function fromMdbItem(item: MdbItem): GridItem {
  return {
    key: `${item.mediatype}:${item.id}`,
    id: item.id,
    tmdbType: toTmdbType(item.mediatype),
    title: item.title,
    poster: upscalePoster(item.poster, 'w342'),
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
    year: (result.release_date || result.first_air_date || '').slice(0, 4),
    vote: result.vote_average || null,
  };
}
