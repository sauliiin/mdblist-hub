import { DatePipe, DecimalPipe, Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { switchMap, tap } from 'rxjs';
import { tmdbImg } from '../../core/api.config';
import { castCharacter, MediaDetailService } from '../../core/media-detail.service';
import { Review, TmdbCastMember, TmdbRecommendation, toMediaType } from '../../core/models';
import { PersonModal } from '../../ui/person-modal/person-modal';
import { RatingBadges } from '../../ui/rating-badges/rating-badges';

@Component({
  selector: 'app-detail',
  imports: [DatePipe, DecimalPipe, RouterLink, PersonModal, RatingBadges],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './detail.html',
  styleUrl: './detail.scss',
})
export class Detail {
  private readonly service = inject(MediaDetailService);
  private readonly location = inject(Location);
  private readonly sanitizer = inject(DomSanitizer);

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
      tap(() => this.loading.set(false)),
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
