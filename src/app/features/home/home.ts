import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged, map, of, switchMap, tap } from 'rxjs';
import { MdblistService } from '../../core/mdblist.service';
import { MdbList, TmdbSearchResult } from '../../core/models';
import { TmdbService } from '../../core/tmdb.service';
import { MediaRow } from '../../ui/media-row/media-row';
import { Hero } from './hero/hero';

type Filter = 'all' | 'movie' | 'show';

@Component({
  selector: 'app-home',
  imports: [DecimalPipe, Hero, MediaRow],
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
  protected readonly searching = signal(false);

  /** Typing switches the page from the list rows to TMDB search results. */
  protected readonly searchMode = computed(() => this.query().trim().length >= 2);

  protected readonly results = toSignal(
    toObservable(this.query).pipe(
      map((q) => q.trim()),
      debounceTime(300),
      distinctUntilChanged(),
      tap((q) => this.searching.set(q.length >= 2)),
      switchMap((q) => (q.length >= 2 ? this.tmdb.search(q) : of<TmdbSearchResult[]>([]))),
      tap(() => this.searching.set(false)),
    ),
    { initialValue: [] as TmdbSearchResult[] },
  );

  /** Search results honour the Filmes/Séries toggle too. */
  protected readonly visibleResults = computed(() => {
    const kind = this.filter();
    const wanted = kind === 'movie' ? 'movie' : kind === 'show' ? 'tv' : null;
    const results = this.results();
    return wanted ? results.filter((r) => r.media_type === wanted) : results;
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

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected clearQuery(): void {
    this.query.set('');
  }
}
