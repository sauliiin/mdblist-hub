import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal,
  viewChild,
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
/** A dead CDN must not hold the cascade on one source forever. */
const STREAM_ATTEMPT_TIMEOUT = 6_000;

/** Decoys in a row that mean the provider, not the mirror, is the problem. */
const DECOY_STREAK_LIMIT = 3;

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
  private readonly videoPlayer = viewChild(VideoPlayer);

  /** Route params and query params, bound by `withComponentInputBinding()`. */
  readonly type = input.required<string>();
  readonly id = input.required<string>();
  readonly season = input<string>();
  readonly episode = input<string>();

  protected readonly addonCount = this.addons.count;

  /** Theater mode widens the video, dropping the side panel below it. */
  protected readonly theater = signal(false);

  /**
   * Opening a title is already the decision to watch — there is no source to
   * pick any more — so playback goes fullscreen on a television and on a
   * phone. A desktop browser keeps the windowed player, where the page around
   * the video is still worth seeing.
   */
  protected readonly autoFullscreen = computed(
    () => this.tv.isTv() || this.platform.handset(),
  );

  /** The candidate currently under test. Never shown as a choice. */
  protected readonly selected = signal<PlayableStream | null>(null);
  /** Reload token lives in the fragment, which is never sent to the stream host. */
  protected readonly playbackSrc = signal<string | null>(null);
  protected readonly playbackError = signal(false);
  protected readonly triedEverySource = signal(false);
  /** Distinguishes "no source worked" from "the provider is refusing everything". */
  protected readonly decoyRateLimited = signal(false);

  /**
   * True from the moment the cascade starts until a source actually plays.
   *
   * The video element is covered while this holds: a cascade swaps `src`
   * several times a second in the bad case, and letting that show is exactly
   * the flicker this design exists to avoid.
   */
  protected readonly resolving = signal(false);
  /** 1-based position in the candidate queue, for the discreet counter. */
  protected readonly attemptAt = signal(0);
  protected readonly candidateCount = signal(0);

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
        this.cancelAttempts();
        this.selected.set(null);
        this.playbackSrc.set(null);
        this.playbackError.set(false);
        this.triedEverySource.set(false);
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

  /**
   * Whether the side panel has anything left to hold. With the source list
   * gone it only carries the episode and subtitle pickers, and a film with no
   * subtitles on offer needs no panel at all — the video takes the full width.
   */
  protected readonly hasPanel = computed(
    () => this.isShow() || this.subtitleOptions().length > 0,
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
  private attemptQueue: PlayableStream[] = [];
  private attemptIndex = -1;
  private attemptSerial = 0;
  private attemptTimer?: ReturnType<typeof setTimeout>;

  /**
   * Sources unmasked as decoys, by url.
   *
   * The queue holds every candidate twice so the cascade gets a second lap;
   * without this, that lap would cheerfully re-open the same "file removed"
   * clip that was just rejected and the user would watch it start again.
   */
  private readonly decoys = new Set<string>();

  /**
   * Decoys hit back to back, without a real source in between.
   *
   * One decoy means one dead mirror. Several in a row means the debrid
   * provider itself is refusing everything — rate limiting, most often — and
   * the placeholder is the same clip whichever candidate asks. Walking sixty
   * more cannot fix that; it just spends a minute reaching the same wall, so
   * the streak turns "try the next one" into "stop and say what is wrong".
   */
  private decoyStreak = 0;

  /**
   * How long this exact thing should run — what makes a decoy recognisable.
   *
   * For an episode the series-level runtime is useless: a 45-minute show next
   * to a two-minute clip is the comparison that matters, not the whole
   * season. So the episode's own runtime wins and the series value is only
   * the fallback.
   */
  protected readonly expectedRuntimeMinutes = computed(() => {
    const detail = this.detail();
    if (!detail) return null;

    if (detail.type === 'show') {
      const current = this.episodes().find(
        (candidate) => candidate.episode_number === this.episodeNumber(),
      );
      if (current?.runtime) return current.runtime;
    }
    return detail.runtime ?? null;
  });

  constructor() {
    /*
     * The sources are never shown, so nothing waits for a choice: as soon as
     * the addons answer, the cascade starts on its own. Which link ends up
     * playing is an implementation detail of getting the film on screen, not a
     * question to put to whoever pressed play.
     */
    effect(() => {
      const streams = this.streams();
      if (this.selected() || this.playbackSrc()) return;

      const first = streams.find((stream) => stream.playable);
      if (first) this.startAttempts(first);
    });

    const destroyRef = inject(DestroyRef);

    // A subtitle is a Blob the page minted; nothing else will free it.
    destroyRef.onDestroy(() => {
      this.cancelAttempts();
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

  /** Runs the whole cascade again, after it gave up on every candidate. */
  protected retry(): void {
    const first = this.streams().find((stream) => stream.playable);
    if (first) this.startAttempts(first);
  }

  /**
   * A source that played, but played the wrong thing. Remembered before it is
   * handed to the normal failure path, so the queue's second lap skips it
   * instead of starting the same removal notice over again.
   */
  protected onDecoyDetected(failedSrc: string): void {
    if (failedSrc !== this.playbackSrc()) return;

    const url = this.selected()?.url;
    if (url) this.decoys.add(url);

    if (++this.decoyStreak >= DECOY_STREAK_LIMIT) {
      this.decoyRateLimited.set(true);
      this.cancelAttempts();
      this.finishPlaybackFailure(false);
      return;
    }
    this.onPlaybackError(failedSrc);
  }

  protected onPlaybackError(failedSrc: string): void {
    // Ignore a delayed error from the source that was just replaced.
    if (failedSrc !== this.playbackSrc()) return;

    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;

    if (this.attemptQueue.length && this.advanceAttempt()) return;
    this.finishPlaybackFailure(this.attemptQueue.length > 0);
  }

  protected onPlaybackReady(playedSrc: string): void {
    if (playedSrc !== this.playbackSrc()) return;

    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;
    this.attemptQueue = [];
    this.attemptIndex = -1;
    this.playbackError.set(false);
    this.triedEverySource.set(false);
    this.decoyRateLimited.set(false);
    this.decoyStreak = 0;
    // The veil comes down only here: the frame is decoding, so what the
    // element shows from now on is the film and not a source being probed.
    this.resolving.set(false);
  }

  /**
   * Queues every playable link, best first, and walks it until one plays.
   *
   * The list is walked twice. A CDN that 403s on the first pass has often
   * handed out a fresh token by the time the queue comes round again, and a
   * second attempt is far cheaper than telling someone to try later.
   */
  private startAttempts(first: PlayableStream): void {
    this.cancelAttempts();
    this.playbackError.set(false);
    this.triedEverySource.set(false);
    this.decoyRateLimited.set(false);
    this.decoyStreak = 0;

    const seen = new Set<string>();
    const candidates = [first, ...this.streams().filter((stream) => stream.key !== first.key)]
      .filter((stream) => {
        if (!stream.playable || !stream.url || seen.has(stream.url)) return false;
        seen.add(stream.url);
        return true;
      });

    this.attemptQueue = [...candidates, ...candidates];
    this.attemptIndex = -1;
    // Scoped to one playback: a url rejected for this title says nothing
    // about the next one, which is a different film behind the same mirror.
    this.decoys.clear();
    this.candidateCount.set(candidates.length);
    this.attemptAt.set(0);
    this.resolving.set(candidates.length > 0);

    if (!this.advanceAttempt()) this.finishPlaybackFailure(true);
  }

  private advanceAttempt(): boolean {
    this.attemptIndex += 1;
    while (this.attemptQueue[this.attemptIndex]?.url &&
      this.decoys.has(this.attemptQueue[this.attemptIndex].url!)) {
      this.attemptIndex += 1;
    }

    const stream = this.attemptQueue[this.attemptIndex];
    if (!stream?.url) return false;

    // Counts within one pass, so the second lap does not read as "17 of 12".
    const total = this.candidateCount() || 1;
    this.attemptAt.set((this.attemptIndex % total) + 1);

    const separator = stream.url.includes('#') ? '&' : '#';
    const attemptSrc = `${stream.url}${separator}mdblist_attempt=${++this.attemptSerial}`;
    this.selected.set(stream);
    this.playbackSrc.set(attemptSrc);

    clearTimeout(this.attemptTimer);
    this.attemptTimer = setTimeout(
      () => this.onPlaybackError(attemptSrc),
      STREAM_ATTEMPT_TIMEOUT,
    );
    return true;
  }

  private finishPlaybackFailure(triedAll: boolean): void {
    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;
    this.resolving.set(false);
    this.playbackError.set(true);
    this.triedEverySource.set(triedAll);
    this.videoPlayer()?.showFailure();
  }

  private cancelAttempts(): void {
    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;
    this.attemptQueue = [];
    this.attemptIndex = -1;
    this.resolving.set(false);
    this.attemptAt.set(0);
    this.candidateCount.set(0);
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
