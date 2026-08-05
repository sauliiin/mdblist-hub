import { DatePipe, DecimalPipe, Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { switchMap, tap } from 'rxjs';
import { tmdbImg } from '../../core/api.config';
import { Bucket, LibraryService, LibraryStatus, LibraryTarget } from '../../core/library.service';
import { castCharacter, MediaDetailService } from '../../core/media-detail.service';
import {
  MediaDetail, Review, TmdbCastMember, TmdbRecommendation, toMediaType,
} from '../../core/models';
import { PersonModal } from '../../ui/person-modal/person-modal';
import { RatingBadges } from '../../ui/rating-badges/rating-badges';
import { ScrollTrack } from '../../ui/scroll-track/scroll-track';

@Component({
  selector: 'app-detail',
  imports: [DatePipe, DecimalPipe, RouterLink, PersonModal, RatingBadges, ScrollTrack],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './detail.html',
  styleUrl: './detail.scss',
})
export class Detail {
  private readonly service = inject(MediaDetailService);
  private readonly location = inject(Location);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly libraryService = inject(LibraryService);

  /** Route params, bound by `withComponentInputBinding()`. */
  readonly type = input.required<string>();
  readonly id = input.required<string>();

  protected readonly loading = signal(true);
  private readonly expanded = signal(new Set<string>());
  protected readonly revealed = signal(new Set<string>());
  protected readonly showAllReviews = signal(false);
  protected readonly trailerOpen = signal(false);
  /** Cast member whose Wikipedia biography is open. */
  protected readonly selectedPerson = signal<TmdbCastMember | null>(null);

  /** mdblist buckets this title belongs to, and the in-flight writes. */
  protected readonly library = signal<LibraryStatus>({
    watchlist: false,
    watched: false,
    collection: false,
  });
  protected readonly pending = signal<Record<Bucket, boolean>>({
    watchlist: false,
    watched: false,
    collection: false,
  });
  protected readonly libraryError = signal<string | null>(null);

  protected readonly libraryActions: {
    bucket: Bucket; label: string; done: string; undo: string;
  }[] = [
    {
      bucket: 'watchlist',
      label: 'Watchlist',
      done: 'Na watchlist',
      undo: 'Remover da watchlist',
    },
    {
      bucket: 'collection',
      label: 'Coleção',
      done: 'Na coleção',
      undo: 'Remover da coleção',
    },
    {
      bucket: 'watched',
      label: 'Marcar como assistido',
      done: 'Assistido',
      undo: 'Desmarcar como assistido',
    },
  ];

  private readonly params = computed(() => ({
    type: toMediaType(this.type()),
    id: Number(this.id()),
  }));

  protected readonly detail = toSignal(
    toObservable(this.params).pipe(
      tap(() => {
        this.loading.set(true);
        this.showAllReviews.set(false);
        this.trailerOpen.set(false);
      }),
      switchMap(({ type, id }) => this.service.load(type, id)),
      tap((detail) => {
        this.loading.set(false);
        if (detail) this.loadLibraryStatus(detail);
      }),
    ),
    { initialValue: null },
  );

  /** YouTube embeds need an explicitly trusted resource URL. */
  protected readonly trailerUrl = computed<SafeResourceUrl | null>(() => {
    const key = this.detail()?.trailerKey;
    return key
      ? this.sanitizer.bypassSecurityTrustResourceUrl(
          `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0`,
        )
      : null;
  });

  protected readonly reviews = computed(() => {
    const all = this.detail()?.reviews ?? [];
    return this.showAllReviews() ? all : all.slice(0, 6);
  });

  protected readonly facts = computed(() => {
    const d = this.detail();
    if (!d) return [];
    const omdb = d.omdb;

    const rows: { label: string; value: string }[] = [];
    const push = (label: string, value: string | null | undefined) => {
      if (value && value !== 'N/A') rows.push({ label, value });
    };

    push('Status', d.status);
    push('Título original', d.originalTitle !== d.title ? d.originalTitle : null);
    push('Classificação', omdb?.Rated);
    push('Direção', d.directors.join(', ') || null);
    push('Roteiro', d.writers.join(', ') || null);
    push('Produção', d.companies.join(', ') || null);
    push('Idiomas', omdb?.Language);
    push('País', omdb?.Country);
    push('Orçamento', d.budget ? money(d.budget) : null);
    push('Bilheteria', d.revenue ? money(d.revenue) : omdb?.BoxOffice);
    push('Prêmios', omdb?.Awards);
    return rows;
  });

  protected readonly runtimeLabel = computed(() => {
    const minutes = this.detail()?.runtime;
    if (!minutes) return null;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}min` : `${m}min`;
  });

  protected readonly seasonsLabel = computed(() => {
    const d = this.detail();
    if (!d || d.type !== 'show' || !d.seasons) return null;
    const seasons = `${d.seasons} temporada${d.seasons > 1 ? 's' : ''}`;
    return d.episodes ? `${seasons} · ${d.episodes} eps` : seasons;
  });

  protected back(): void {
    this.location.back();
  }

  protected character(member: TmdbCastMember): string {
    return castCharacter(member);
  }

  protected openPerson(member: TmdbCastMember): void {
    this.selectedPerson.set(member);
  }

  private loadLibraryStatus(detail: MediaDetail): void {
    this.library.set({ watchlist: false, watched: false, collection: false });
    this.libraryService.status(this.target(detail)).subscribe((status) => this.library.set(status));
  }

  /** Adds or removes the title from an mdblist bucket. */
  protected toggleBucket(bucket: Bucket): void {
    const detail = this.detail();
    if (!detail || this.pending()[bucket]) return;

    const add = !this.library()[bucket];
    this.libraryError.set(null);
    this.pending.update((state) => ({ ...state, [bucket]: true }));

    this.libraryService.toggle(bucket, this.target(detail), add).subscribe({
      next: (state) => {
        this.library.update((current) => ({ ...current, [bucket]: state }));
        this.pending.update((state) => ({ ...state, [bucket]: false }));
      },
      error: () => {
        this.pending.update((state) => ({ ...state, [bucket]: false }));
        // Almost always the missing proxy: the write endpoints cannot be
        // reached from a plain static host (see README).
        this.libraryError.set(
          'Não foi possível gravar no mdblist. As ações de biblioteca precisam do proxy — veja o README.',
        );
      },
    });
  }

  private target(detail: MediaDetail): LibraryTarget {
    return { imdbId: detail.imdbId, tmdbId: detail.tmdbId, type: detail.type };
  }

  protected profile(member: TmdbCastMember): string | null {
    return tmdbImg(member.profile_path, 'w185');
  }

  protected recPoster(rec: TmdbRecommendation): string | null {
    return tmdbImg(rec.poster_path, 'w342');
  }

  protected recLink(rec: TmdbRecommendation): unknown[] {
    const type = rec.media_type ?? (rec.title ? 'movie' : 'tv');
    return ['/title', type, rec.id];
  }

  protected recTitle(rec: TmdbRecommendation): string {
    return rec.title || rec.name || '';
  }

  protected recYear(rec: TmdbRecommendation): string {
    return (rec.release_date || rec.first_air_date || '').slice(0, 4);
  }

  protected isExpanded(review: Review): boolean {
    return this.expanded().has(review.id);
  }

  /** Roughly the point where the 4-line clamp starts hiding text. */
  protected isLong(review: Review): boolean {
    return review.content.length > 300 || review.content.split('\n').length > 4;
  }

  protected toggle(review: Review): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      next.has(review.id) ? next.delete(review.id) : next.add(review.id);
      return next;
    });
  }

  protected reveal(review: Review): void {
    this.revealed.update((set) => new Set(set).add(review.id));
  }

  protected isHidden(review: Review): boolean {
    return review.spoiler && !this.revealed().has(review.id);
  }
}

function money(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}
