import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Observable, debounceTime, distinctUntilChanged, of, switchMap, tap } from 'rxjs';
import { tmdbImg } from '../../core/api.config';
import { MdblistService } from '../../core/mdblist.service';
import { GenreOption, MdbList, TmdbSearchResult } from '../../core/models';
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

  /** A query or a genre swaps the list rows for a grid of TMDB results. */
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
    { initialValue: [] as TmdbSearchResult[] },
  );

  /** Results honour the Filmes/Séries toggle and the genre together. */
  protected readonly visibleResults = computed(() => {
    const kind = this.filter();
    const wanted = kind === 'movie' ? 'movie' : kind === 'show' ? 'tv' : null;
    const selected = this.selectedGenre();
    // `discover` already filtered by genre; only text results need it applied.
    const textSearch = this.query().trim().length >= 2;

    return this.results().filter((result) => {
      if (wanted && result.media_type !== wanted) return false;

      if (textSearch && selected) {
        const wantedId = result.media_type === 'tv' ? selected.tvId : selected.movieId;
        if (!wantedId || !(result.genre_ids ?? []).includes(wantedId)) return false;
      }

      return true;
    });
  });

  protected readonly resultsLabel = computed(() => {
    const query = this.query().trim();
    const genre = this.genre();
    if (query && genre) return `“${query}” em ${genre}`;
    if (query) return `“${query}”`;
    return genre;
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

  private selectedGenre(): GenreOption | null {
    const name = this.genre();
    return name ? this.genres().find((g) => g.name === name) ?? null : null;
  }

  /** Text search wins; the genre then narrows it. Genre alone browses it. */
  private fetch(criteria: Criteria): Observable<TmdbSearchResult[]> {
    if (criteria.query.length >= 2) return this.tmdb.search(criteria.query);

    if (criteria.genre) {
      const option = this.genres().find((g) => g.name === criteria.genre);
      const tmdbType = criteria.kind === 'show' ? 'tv' : 'movie';
      const genreId = tmdbType === 'tv' ? option?.tvId : option?.movieId;
      return genreId ? this.tmdb.discover(tmdbType, genreId) : of([]);
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

  protected poster(result: TmdbSearchResult): string | null {
    return tmdbImg(result.poster_path, 'w342');
  }

  protected titleOf(result: TmdbSearchResult): string {
    return result.title || result.name || 'Sem título';
  }

  protected yearOf(result: TmdbSearchResult): string {
    return (result.release_date || result.first_air_date || '').slice(0, 4);
  }
}
