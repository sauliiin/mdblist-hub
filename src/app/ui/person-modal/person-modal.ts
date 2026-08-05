import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, of, switchMap } from 'rxjs';
import { tmdbImg } from '../../core/api.config';
import { TmdbPerson, TmdbPersonCredit } from '../../core/models';
import { TmdbService } from '../../core/tmdb.service';
import { WikiBio, WikipediaService } from '../../core/wikipedia.service';

@Component({
  selector: 'app-person-modal',
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './person-modal.html',
  styleUrl: './person-modal.scss',
})
export class PersonModal {
  private readonly tmdb = inject(TmdbService);
  private readonly wikipedia = inject(WikipediaService);

  readonly personId = input.required<number>();
  /** Shown while TMDB has not answered yet, so the panel is never empty. */
  readonly fallbackName = input<string>('');
  readonly closed = output<void>();

  protected readonly person = signal<TmdbPerson | null>(null);
  protected readonly wiki = signal<WikiBio | null>(null);
  protected readonly loading = signal(true);

  protected readonly photo = computed(() => tmdbImg(this.person()?.profile_path, 'w342'));

  /** Wikipedia is the primary biography; TMDB's is the fallback. */
  protected readonly bio = computed(() => {
    const fromWiki = this.wiki()?.biography?.trim();
    if (fromWiki) return { text: fromWiki, source: 'wikipedia' as const };

    const fromTmdb = this.person()?.biography?.trim();
    if (fromTmdb) return { text: fromTmdb, source: 'tmdb' as const };

    return null;
  });

  protected readonly birthday = computed(
    () => this.wiki()?.birthday ?? this.person()?.birthday ?? null,
  );
  protected readonly deathday = computed(
    () => this.wiki()?.deathday ?? this.person()?.deathday ?? null,
  );
  protected readonly birthplace = computed(
    () => this.wiki()?.placeOfBirth ?? this.person()?.place_of_birth ?? null,
  );

  protected readonly age = computed(() => {
    const birth = this.birthday();
    if (!birth || birth.length < 10) return null;

    const end = this.deathday() ? new Date(this.deathday()!) : new Date();
    const start = new Date(birth);
    let years = end.getFullYear() - start.getFullYear();
    const monthDiff = end.getMonth() - start.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && end.getDate() < start.getDate())) years--;
    return years > 0 && years < 130 ? years : null;
  });

  /** The person's best-known titles, most voted first. */
  protected readonly knownFor = computed<TmdbPersonCredit[]>(() => {
    const credits = this.person()?.combined_credits?.cast ?? [];
    const seen = new Set<number>();

    return credits
      .filter((c) => {
        if (!c.poster_path || seen.has(c.id)) return false;
        seen.add(c.id);
        return c.media_type === 'movie' || c.media_type === 'tv';
      })
      .sort((a, b) => b.vote_count - a.vote_count)
      .slice(0, 10);
  });

  constructor() {
    effect(() => {
      const id = this.personId();
      this.person.set(null);
      this.wiki.set(null);
      this.loading.set(true);

      this.tmdb
        .person(id)
        .pipe(
          switchMap((person) => {
            this.person.set(person);
            return forkJoin({
              wiki: this.wikipedia.person(id, person?.external_ids?.imdb_id ?? null),
              person: of(person),
            });
          }),
        )
        .subscribe(({ wiki }) => {
          this.wiki.set(wiki);
          this.loading.set(false);
        });
    });
  }

  @HostListener('document:keydown.escape')
  protected close(): void {
    this.closed.emit();
  }

  protected creditPoster(credit: TmdbPersonCredit): string | null {
    return tmdbImg(credit.poster_path, 'w185');
  }

  protected creditLink(credit: TmdbPersonCredit): unknown[] {
    return ['/title', credit.media_type === 'tv' ? 'tv' : 'movie', credit.id];
  }

  protected creditTitle(credit: TmdbPersonCredit): string {
    return credit.title || credit.name || '';
  }

  protected creditYear(credit: TmdbPersonCredit): string {
    return (credit.release_date || credit.first_air_date || '').slice(0, 4);
  }
}
