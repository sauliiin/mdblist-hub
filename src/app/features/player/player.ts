import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { of, switchMap, tap } from 'rxjs';
import { MediaDetailService } from '../../core/media-detail.service';
import { TmdbEpisode, toMediaType } from '../../core/models';
import { AddonsService } from '../../core/stremio/addons.service';
import {
  PlayableStream, StreamQuery, SubtitleOption, stremioId, toStremioType,
} from '../../core/stremio/models';
import { PlatformService } from '../../core/platform.service';
import { ScrobbleTarget } from '../../core/scrobble/models';
import { TvService } from '../../core/tv/tv.service';
import { ScrobbleService } from '../../core/scrobble/scrobble.service';
import { StremioService } from '../../core/stremio/stremio.service';
import { TmdbService } from '../../core/tmdb.service';
import { VideoPlayer } from '../../ui/video-player/video-player';

const EMPTY_QUERY: StreamQuery = { streams: [], queried: 0, failed: 0 };

/** Human text for the reasons a stream cannot reach `<video>`. */
const REASONS: Record<string, string> = {
  torrent: 'Torrent — o navegador não fala BitTorrent. Configure o addon com um debrid, ou use o magnet.',
  insecure: 'O addon devolveu um link http://, que uma página https bloqueia.',
  external: 'Este addon aponta para uma página, não para um arquivo de vídeo.',
};

@Component({
  selector: 'app-player',
  imports: [RouterLink, VideoPlayer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player.html',
  styleUrl: './player.scss',
})
export class Player {
  private readonly service = inject(MediaDetailService);
  private readonly stremio = inject(StremioService);
  private readonly tmdb = inject(TmdbService);
  private readonly addons = inject(AddonsService);
  private readonly scrobble = inject(ScrobbleService);
  private readonly tv = inject(TvService);
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);

  /** Route params and query params, bound by `withComponentInputBinding()`. */
  readonly type = input.required<string>();
  readonly id = input.required<string>();
  readonly season = input<string>();
  readonly episode = input<string>();

  protected readonly addonCount = this.addons.count;

  /** Theater mode drops the source list below the video instead of beside it. */
  protected readonly theater = signal(false);

  /**
   * On a television and on a phone, picking a source is a decision to watch —
   * so playback opens fullscreen straight away. A desktop browser keeps the
   * windowed player, where comparing sources back to back is the common case
   * and being thrown into fullscreen each time would fight the user.
   */
  protected readonly autoFullscreen = computed(
    () => this.tv.isTv() || this.platform.handset(),
  );

  protected readonly selected = signal<PlayableStream | null>(null);
  protected readonly playbackError = signal(false);
  /** Key of the stream whose link was just copied, for the button's feedback. */
  protected readonly copied = signal<string | null>(null);

  protected readonly subtitle = signal<SubtitleOption | null>(null);
  protected readonly subtitleUrl = signal<string | null>(null);
  protected readonly subtitleError = signal<string | null>(null);
  protected readonly subtitleBusy = signal(false);

  protected readonly loadingStreams = signal(false);
  protected readonly loadingDetail = signal(true);

  protected readonly seasonNumber = computed(() => Number(this.season() ?? 1) || 1);
  protected readonly episodeNumber = computed(() => Number(this.episode() ?? 1) || 1);

  private readonly params = computed(() => ({
    type: toMediaType(this.type()),
    id: Number(this.id()),
  }));

  protected readonly detail = toSignal(
    toObservable(this.params).pipe(
      tap(() => this.loadingDetail.set(true)),
      switchMap(({ type, id }) => this.service.load(type, id)),
      tap(() => this.loadingDetail.set(false)),
    ),
    { initialValue: null },
  );

  protected readonly isShow = computed(() => this.detail()?.type === 'show');

  /** Seasons TMDB lists for the show, with the specials bucket dropped. */
  protected readonly seasons = toSignal(
    toObservable(this.params).pipe(
      switchMap(({ type, id }) =>
        type === 'show' ? this.tmdb.detail(type, id) : of(null),
      ),
      switchMap((tmdb) =>
        of((tmdb?.seasons ?? []).filter((s) => s.season_number > 0 && s.episode_count > 0)),
      ),
    ),
    { initialValue: [] },
  );

  protected readonly episodes = toSignal(
    toObservable(computed(() => ({ ...this.params(), season: this.seasonNumber() }))).pipe(
      switchMap(({ type, id, season }) =>
        type === 'show' ? this.tmdb.season(id, season) : of(null),
      ),
      switchMap((data) => of(data?.episodes ?? [])),
    ),
    { initialValue: [] as TmdbEpisode[] },
  );

  /**
   * The id addons are keyed by: the bare IMDb id for a film, `imdb:s:e` for an
   * episode. Null whenever we have nothing to ask with, which is the one case
   * the page cannot recover from.
   */
  private readonly streamKey = computed(
    () => {
      const detail = this.detail();
      if (!detail?.imdbId) return null;

      const type = toStremioType(detail.type);
      return {
        type,
        id:
          type === 'series'
            ? stremioId(detail.imdbId, this.seasonNumber(), this.episodeNumber())
            : stremioId(detail.imdbId),
      };
    },
    // Season and episode arrive as two separate input writes, and a fresh
    // object each time would fan out to every addon twice per change.
    { equal: (a, b) => a?.type === b?.type && a?.id === b?.id },
  );

  /** What scrobble calls point at — the title, plus the episode for a show. */
  private readonly scrobbleTarget = computed<ScrobbleTarget | null>(
    () => {
      const detail = this.detail();
      if (!detail) return null;

      return {
        type: detail.type,
        imdbId: detail.imdbId,
        tmdbId: detail.tmdbId,
        season: detail.type === 'show' ? this.seasonNumber() : null,
        episode: detail.type === 'show' ? this.episodeNumber() : null,
      };
    },
    {
      equal: (a, b) =>
        a?.tmdbId === b?.tmdbId && a?.season === b?.season && a?.episode === b?.episode,
    },
  );

  protected readonly missingImdbId = computed(
    () => !this.loadingDetail() && !!this.detail() && !this.detail()!.imdbId,
  );

  private readonly query = toSignal(
    toObservable(this.streamKey).pipe(
      tap(() => {
        this.loadingStreams.set(true);
        this.selected.set(null);
        this.playbackError.set(false);
      }),
      switchMap((key) =>
        key ? this.stremio.streams(key.type, key.id) : of(EMPTY_QUERY),
      ),
      tap(() => this.loadingStreams.set(false)),
    ),
    { initialValue: EMPTY_QUERY },
  );

  protected readonly streams = computed(() => this.query().streams);

  protected readonly subtitleOptions = toSignal(
    toObservable(this.streamKey).pipe(
      tap(() => this.clearSubtitle()),
      switchMap((key) => (key ? this.stremio.subtitles(key.type, key.id) : of([]))),
    ),
    { initialValue: [] as SubtitleOption[] },
  );

  protected readonly playableCount = computed(
    () => this.streams().filter((s) => s.playable).length,
  );

  /** How many installed addons were actually asked, and how many broke. */
  protected readonly queried = computed(() => this.query().queried);
  protected readonly failed = computed(() => this.query().failed);

  /**
   * Which of the empty-list cases we are in. Installing an addon that only
   * serves subtitles and expecting sources out of it is an easy mistake to
   * make, and "nobody answered" would be the wrong thing to say about it.
   */
  protected readonly emptyCase = computed<'no-addons' | 'none-serve' | 'all-failed' | 'nothing'>(
    () => {
      if (!this.addonCount()) return 'no-addons';
      if (!this.queried()) return 'none-serve';
      if (this.failed() === this.queried()) return 'all-failed';
      return 'nothing';
    },
  );

  /** The installed addons, named, for the "none serve streams" message. */
  protected readonly installedNames = computed(() =>
    this.addons.installed().map((a) => a.manifest.name).join(', '),
  );

  protected readonly episodeLabel = computed(() => {
    if (!this.isShow()) return null;
    const number = `T${this.seasonNumber()}E${this.episodeNumber()}`;
    const found = this.episodes().find((e) => e.episode_number === this.episodeNumber());
    return found ? `${number} · ${found.name}` : number;
  });

  /** The point mdblist has stored for this title, 0–100. */
  protected readonly resumeAt = toSignal(
    toObservable(this.scrobbleTarget).pipe(
      switchMap((target) => (target ? this.scrobble.resumeFor(target) : of(null))),
    ),
    { initialValue: null },
  );

  protected readonly scrobbleError = this.scrobble.error;

  /** Progress of the last report, so leaving the page can stop at the right point. */
  private lastProgress = 0;

  constructor() {
    /*
     * On a TV, arriving here from "Assistir" should slide straight to the
     * sources: the video pane is empty until one is picked, so leaving focus
     * anywhere else means the first press of the remote goes nowhere useful.
     */
    effect(() => {
      const streams = this.streams();
      if (!this.tv.isTv() || this.selected() || !streams.length) return;

      setTimeout(() => {
        const first = document.querySelector<HTMLElement>('.source:not([disabled])');
        first?.focus({ preventScroll: true });
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });

    const destroyRef = inject(DestroyRef);

    // A subtitle is a Blob the page minted; nothing else will free it.
    destroyRef.onDestroy(() => {
      this.revoke();
      this.reportStop();
    });

    /*
     * Closing the tab is a "quit" that never reaches ngOnDestroy. `sendBeacon`
     * is the only request the browser promises to deliver at that point — and
     * it can only send simple requests, which is exactly what the form-encoded
     * scrobble body already is.
     *
     * The removal matters: `Player` is a routed component, so every visit to a
     * title built another listener over the previous ones, each holding this
     * whole component alive. Browsing twenty titles left twenty of them, all
     * firing on the way out and scrobbling from dead instances.
     */
    const onPageHide = () => this.beaconStop();
    addEventListener('pagehide', onPageHide);
    destroyRef.onDestroy(() => removeEventListener('pagehide', onPageHide));
  }

  /** Fires on pause, play and the periodic refresh coming out of the player. */
  protected onPlaybackState(event: { action: 'start' | 'pause' | 'stop'; progress: number }): void {
    const target = this.scrobbleTarget();
    if (!target) return;

    this.lastProgress = event.progress;
    this.scrobble[event.action](target, event.progress).subscribe();
  }

  private reportStop(): void {
    const target = this.scrobbleTarget();
    if (target && this.lastProgress > 0) {
      this.scrobble.stop(target, this.lastProgress).subscribe();
    }
  }

  private beaconStop(): void {
    const target = this.scrobbleTarget();
    if (target && this.lastProgress > 0) this.scrobble.beaconStop(target, this.lastProgress);
  }

  protected back(): void {
    this.location.back();
  }

  protected detailLink(): unknown[] {
    return ['/title', this.type(), this.id()];
  }

  protected pick(stream: PlayableStream): void {
    if (!stream.playable) return;
    this.playbackError.set(false);
    this.selected.set(stream);
  }

  protected onPlaybackError(): void {
    this.playbackError.set(true);
  }

  protected reason(stream: PlayableStream): string | null {
    return stream.reason ? REASONS[stream.reason] ?? null : null;
  }

  /** Torrent streams get a magnet; direct ones get the URL itself. */
  protected copy(stream: PlayableStream): void {
    if (!stream.externalUrl) return;

    navigator.clipboard.writeText(stream.externalUrl).then(() => {
      this.copied.set(stream.key);
      setTimeout(() => this.copied.set(null), 2000);
    });
  }

  protected chooseSeason(event: Event): void {
    this.navigate(Number((event.target as HTMLSelectElement).value), 1);
  }

  protected chooseEpisode(event: Event): void {
    this.navigate(this.seasonNumber(), Number((event.target as HTMLSelectElement).value));
  }

  private navigate(season: number, episode: number): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { season, episode },
      queryParamsHandling: 'merge',
    });
  }

  /** The sidebar's own `<select>`, kept for the windowed desktop player. */
  protected chooseSubtitle(event: Event): void {
    const key = (event.target as HTMLSelectElement).value;
    this.selectSubtitle(this.subtitleOptions().find((s) => s.key === key) ?? null);
  }

  /** The in-player chooser — the only way to pick a subtitle once fullscreen. */
  protected onSubtitleSelect(option: SubtitleOption | null): void {
    this.selectSubtitle(option);
  }

  private selectSubtitle(option: SubtitleOption | null): void {
    this.clearSubtitle();
    if (!option) return;

    this.subtitle.set(option);
    this.subtitleBusy.set(true);

    this.stremio.subtitleTrack(option).subscribe({
      next: (url) => {
        this.subtitleBusy.set(false);
        this.subtitleUrl.set(url);
      },
      error: () => {
        this.subtitleBusy.set(false);
        // Nearly always CORS: the addon lists the file, but the host it is
        // mirrored on does not allow a cross-origin read.
        this.subtitleError.set(
          'O arquivo da legenda não pôde ser baixado — o servidor que a hospeda não libera ' +
            'acesso a partir do navegador. Tente outra legenda da lista.',
        );
      },
    });
  }

  private clearSubtitle(): void {
    this.revoke();
    this.subtitle.set(null);
    this.subtitleUrl.set(null);
    this.subtitleError.set(null);
  }

  private revoke(): void {
    const url = this.subtitleUrl();
    if (url) URL.revokeObjectURL(url);
  }
}
