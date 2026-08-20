import { DatePipe, DecimalPipe, Location } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { switchMap, tap } from 'rxjs';
import { tmdbImg } from '../../core/api.config';
import { AuthService } from '../../core/auth.service';
import { activeLocale, I18nPipe, I18nService } from '../../core/i18n.service';
import { Bucket, LibraryService, LibraryStatus, LibraryTarget } from '../../core/library.service';
import { castCharacter, MediaDetailService } from '../../core/media-detail.service';
import {
  MediaDetail, Review, TmdbCastMember, TmdbRecommendation, formatYear, toMediaType,
} from '../../core/models';
import { ThemePrefsService, isLandscapeTheme } from '../../core/theme-prefs.service';
import { TvService } from '../../core/tv/tv.service';
import { ResumeItem, ScrobbleTarget } from '../../core/scrobble/models';
import { ScrobbleService } from '../../core/scrobble/scrobble.service';
import { EpisodeRow } from './episode-row/episode-row';
import { PersonModal } from '../../ui/person-modal/person-modal';
import { RatingBadges } from '../../ui/rating-badges/rating-badges';
import { ScrollTrack } from '../../ui/scroll-track/scroll-track';

@Component({
  selector: 'app-detail',
  imports: [
    DatePipe, DecimalPipe, I18nPipe, RouterLink, EpisodeRow, PersonModal, RatingBadges, ScrollTrack,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './detail.html',
  styleUrl: './detail.scss',
})
export class Detail {
  private readonly service = inject(MediaDetailService);
  private readonly location = inject(Location);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly libraryService = inject(LibraryService);
  private readonly scrobble = inject(ScrobbleService);
  private readonly auth = inject(AuthService);
  protected readonly tv = inject(TvService);
  protected readonly canPlay = this.auth.canPlay;
  protected readonly canSaveToLibrary = this.auth.canSaveToLibrary;
  protected readonly theme = inject(ThemePrefsService).themeKey;
  protected readonly landscapeTheme = computed(() => isLandscapeTheme(this.theme()));
  private readonly i18n = inject(I18nService);
  protected readonly formatYear = formatYear;

  private readonly lightbox = viewChild<ElementRef<HTMLElement>>('lightbox');
  private readonly watchBtn = viewChild<ElementRef<HTMLElement>>('watchBtn');

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
  protected readonly resumeSession = signal<ResumeItem | null>(null);
  protected readonly clearingProgress = signal(false);

  protected readonly libraryActions: {
    bucket: Bucket; label: string; done: string; undo: string;
  }[] = [
    {
      bucket: 'watchlist',
      label: this.i18n.t('Watchlist'),
      done: this.i18n.t('In watchlist'),
      undo: this.i18n.t('Remove from watchlist'),
    },
    {
      bucket: 'collection',
      label: this.i18n.t('Collection'),
      done: this.i18n.t('In collection'),
      undo: this.i18n.t('Remove from collection'),
    },
    {
      bucket: 'watched',
      label: this.i18n.t('Mark as watched'),
      done: this.i18n.t('Watched'),
      undo: this.i18n.t('Mark as unwatched'),
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
        this.resumeSession.set(null);
        this.showAllReviews.set(false);
        this.trailerOpen.set(false);
      }),
      switchMap(({ type, id }) => this.service.load(type, id)),
      tap((detail) => {
        this.loading.set(false);
        if (detail) {
          this.loadLibraryStatus(detail);
          this.loadProgress(detail);
        }
      }),
    ),
    { initialValue: null },
  );

  constructor() {
    /*
     * On TV, arriving at a title's page is overwhelmingly "I came here to
     * watch this" — landing the remote's focus anywhere else (the trailer
     * button, IMDb, the library actions) means an extra press just to reach
     * the one thing most people are here for.
     */
    effect(() => {
      if (!this.detail() || !this.tv.isTv()) return;
      setTimeout(() => this.watchBtn()?.nativeElement.focus({ preventScroll: true }));
    });
  }

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

    push(this.i18n.t('Status'), d.status ? this.i18n.t(d.status) : null);
    push(this.i18n.t('Original title'), d.originalTitle !== d.title ? d.originalTitle : null);
    push(this.i18n.t('Certification'), omdb?.Rated);
    push(this.i18n.t('Director'), d.directors.join(', ') || null);
    push(this.i18n.t('Writing'), d.writers.join(', ') || null);
    push(this.i18n.t('Production'), d.companies.join(', ') || null);
    push(this.i18n.t('Languages'), omdb?.Language);
    push(this.i18n.t('Country'), omdb?.Country);
    push(this.i18n.t('Budget'), d.budget ? money(d.budget) : null);
    push(this.i18n.t('Revenue'), d.revenue ? money(d.revenue) : omdb?.BoxOffice);
    push(this.i18n.t('Awards'), omdb?.Awards);
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
    const seasons = this.i18n.t(d.seasons === 1 ? '{count} season' : '{count} seasons', {
      count: d.seasons,
    });
    return d.episodes ? `${seasons} · ${d.episodes} eps` : seasons;
  });

  /**
   * On a TV the trailer is the whole screen, not a box inside a page — the
   * lightbox itself goes fullscreen so the video fills the set.
   *
   * Elsewhere the overlay is already large enough and being thrown into
   * fullscreen for a two-minute trailer would be heavy-handed.
   */
  protected openTrailer(): void {
    this.trailerOpen.set(true);
    if (!this.tv.isTv()) return;

    // The element only exists once the template has reacted to the signal, and
    // the click that got us here keeps the activation valid meanwhile.
    setTimeout(() =>
      void this.lightbox()?.nativeElement.requestFullscreen?.().catch(() => undefined),
    );
  }

  protected closeTrailer(): void {
    this.trailerOpen.set(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }

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

  private loadProgress(detail: MediaDetail): void {
    this.scrobble.sessionForTitle(this.scrobbleTarget(detail)).subscribe((session) => {
      // Ignore a response belonging to a route that changed while the request
      // was in flight.
      const current = this.params();
      if (current.id === detail.tmdbId && current.type === detail.type) this.resumeSession.set(session);
    });
  }

  protected clearProgress(): void {
    const detail = this.detail();
    const session = this.resumeSession();
    if (!detail || !session || this.clearingProgress()) return;

    this.clearingProgress.set(true);
    this.libraryError.set(null);
    const target: ScrobbleTarget = {
      type: session.type,
      imdbId: session.imdbId ?? detail.imdbId,
      tmdbId: session.tmdbId ?? detail.tmdbId,
      season: session.season,
      episode: session.episode,
    };

    this.scrobble.clear(target, session.playbackId).subscribe((cleared) => {
      this.clearingProgress.set(false);
      if (cleared) this.resumeSession.set(null);
      else this.libraryError.set(this.i18n.t('Could not clear playback progress.'));
    });
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
          this.i18n.t('Could not save to mdblist. Library actions require the proxy — see the README.'),
        );
      },
    });
  }

  private target(detail: MediaDetail): LibraryTarget {
    return { imdbId: detail.imdbId, tmdbId: detail.tmdbId, type: detail.type };
  }

  private scrobbleTarget(detail: MediaDetail): ScrobbleTarget {
    return { imdbId: detail.imdbId, tmdbId: detail.tmdbId, type: detail.type };
  }

  protected profile(member: TmdbCastMember): string | null {
    return tmdbImg(member.profile_path, 'w185');
  }

  protected recPoster(rec: TmdbRecommendation): string | null {
    return tmdbImg(rec.poster_path, 'w342');
  }

  /** Primefly's landscape art — free, TMDB's recommendations already carry a backdrop. */
  protected recBackdrop(rec: TmdbRecommendation): string | null {
    return tmdbImg(rec.backdrop_path, 'w780');
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

  /**
   * OK/Enter on a focused review card, for the TV build.
   *
   * Without a card-level tabindex, spatial navigation's closest-candidate
   * search only finds the "Ler tudo"/spoiler *button* inside each review — the
   * card itself was never a stop — so pressing down skipped straight to
   * whichever review happened to have one, past every short review in between.
   * Making the whole card focusable fixes the skipping; this is what makes OK
   * do something useful once it lands there instead of on the nested button.
   */
  protected activateReview(review: Review): void {
    if (this.isHidden(review)) this.reveal(review);
    else if (this.isLong(review)) this.toggle(review);
  }

  protected isHidden(review: Review): boolean {
    return review.spoiler && !this.revealed().has(review.id);
  }
}

function money(value: number): string {
  return value.toLocaleString(activeLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}
