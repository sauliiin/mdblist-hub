import { Location } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, of, startWith, switchMap, tap } from 'rxjs';
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
import { bestSubtitleMatch } from '../../core/stremio/subtitle-matcher';
import { TmdbService } from '../../core/tmdb.service';
import { isLikelyRemovalNotice } from '../../ui/video-player/decoy-detector';
import { VideoPlayer } from '../../ui/video-player/video-player';
import { CandidateRace, ProbeHandle, ProbeOutcome } from './candidate-race';

const EMPTY_QUERY: StreamQuery = { streams: [], queried: 0, failed: 0 };
/** Enough parallelism to get past a slow mirror without walking the list for minutes. */
const STREAM_PROBE_CONCURRENCY = 16;
/** Real sources in the reproduction case needed 7–12s before producing frames. */
const STREAM_PROBE_TIMEOUT = 16_000;
/**
 * The one-shot retry a merely-timed-out candidate gets, run with far less
 * concurrency (so it isn't fighting 15 other downloads for bandwidth again)
 * and more time to land.
 */
const RETRY_PROBE_CONCURRENCY = 4;
const RETRY_PROBE_TIMEOUT = 30_000;

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

  /** The candidate currently under test. Never shown as a choice while the automatic cascade still has one to make. */
  protected readonly selected = signal<PlayableStream | null>(null);
  /** Reload token lives in the fragment, which is never sent to the stream host. */
  protected readonly playbackSrc = signal<string | null>(null);
  protected readonly playbackError = signal(false);
  protected readonly triedEverySource = signal(false);
  /** Distinguishes "no source worked" from "the provider is refusing everything". */
  protected readonly decoyRateLimited = signal(false);

  /** The post-exhaustion manual picker (entry point A) is open. */
  protected readonly manuallyPicking = signal(false);
  /**
   * True once the user has picked a source by hand — either from the
   * exhaustion picker or by swapping mid-playback. A manual pick that then
   * fails does not fall back to blind automatic racing: `resumeRace` checks
   * this and returns to the picker instead, the same way the native apps'
   * `PlaybackController` treats a failed manual pick as its own outcome
   * rather than silently resuming the cascade.
   */
  private manualPickMode = false;

  /**
   * True from the moment the cascade starts until a source actually plays.
   *
   * The video element is covered while this holds: a cascade swaps `src`
   * several times a second in the bad case, and letting that show is exactly
   * the flicker this design exists to avoid.
   */
  protected readonly resolving = signal(false);
  /** Number of unique candidates whose probes have already started. */
  protected readonly attemptAt = signal(0);
  protected readonly candidateCount = signal(0);

  protected readonly subtitle = signal<SubtitleOption | null>(null);
  protected readonly subtitleUrl = signal<string | null>(null);
  protected readonly subtitleError = signal<string | null>(null);
  protected readonly subtitleBusy = signal(false);
  /** The candidate that reached actual playback, rather than merely being attempted. */
  private readonly confirmedStream = signal<PlayableStream | null>(null);

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
        this.raceStarted = false;
        this.rejectedUrls.clear();
        this.timedOutUrls.clear();
        this.retriedTimeouts = false;
        this.launchedUrls.clear();
        this.decoyCount = 0;
        this.selected.set(null);
        this.playbackSrc.set(null);
        this.playbackError.set(false);
        this.triedEverySource.set(false);
        this.manuallyPicking.set(false);
        this.manualPickMode = false;
      }),
      switchMap((key) =>
        key ? this.stremio.streams(key.type, key.id) : of(EMPTY_QUERY),
      ),
      tap(() => this.loadingStreams.set(false)),
    ),
    { initialValue: EMPTY_QUERY },
  );

  protected readonly streams = computed(() => this.query().streams);
  /** Candidates for the manual picker (both entry points) — same de-duped set the automatic race itself consumes. */
  protected readonly manualPickOptions = computed(() => this.playableCandidates());

  protected readonly subtitleOptions = toSignal(
    toObservable(this.streamKey).pipe(
      tap(() => this.resetSubtitleContext()),
      switchMap((key) => (key
        ? this.stremio.subtitles(key.type, key.id).pipe(startWith([] as SubtitleOption[]))
        : of([]))),
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

  /**
   * Where a stalled-out source died, in seconds — set by [onPlaybackStalledOut],
   * cleared once the next candidate confirms playback. Takes priority over
   * [resumeAt] in `VideoPlayer` so failover picks up exactly where the dead
   * source left off instead of restarting from mdblist's stored percentage.
   */
  protected readonly stallResumeSeconds = signal<number | null>(null);

  /** Progress of the last report, so leaving the page can stop at the right point. */
  private lastProgress = 0;
  private attemptSerial = 0;
  private playbackTimer?: ReturnType<typeof setTimeout>;
  private race?: CandidateRace<PlayableStream>;
  private raceStarted = false;
  private readonly rejectedUrls = new Set<string>();
  /** Probes that only timed out — ambiguous, so they get one retry before joining `rejectedUrls`. */
  private readonly timedOutUrls = new Set<string>();
  private retriedTimeouts = false;
  private readonly launchedUrls = new Set<string>();
  private decoyCount = 0;
  private subtitleRequest?: Subscription;

  /** Manual selection, including "sem legenda", always disables automation for this title. */
  private subtitleChosenByUser = false;
  private autoSelectedForStream: string | null = null;

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
      if (this.selected() || this.playbackSrc() || this.raceStarted) return;

      const first = streams.find((stream) => stream.playable);
      if (first) this.startAttempts(first);
    });

    /*
     * Wait for both halves of a trustworthy match: the source that really
     * reached `playing` and the complete subtitle result. This prevents a
     * subtitle being chosen for a high-ranked stream that the cascade later
     * rejects, and never overrides a deliberate user choice.
     */
    effect(() => {
      const stream = this.confirmedStream();
      const options = this.subtitleOptions();
      if (!stream || !options.length || this.subtitleChosenByUser ||
        this.autoSelectedForStream === stream.key) return;

      const release = [stream.title, stream.filename, stream.detail].filter(Boolean).join(' ');
      const match = bestSubtitleMatch(options, release);
      if (!match) return;

      this.autoSelectedForStream = stream.key;
      this.applySubtitle(match);
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

  /** Runs a fresh race after every candidate in the previous one failed. */
  protected retry(): void {
    this.manualPickMode = false;
    const first = this.streams().find((stream) => stream.playable);
    if (first) this.startAttempts(first);
  }

  /**
   * Opens the chosen candidate directly, bypassing the race entirely — the
   * same thing `promote()` does for an automatic winner, just called by hand.
   * Two entry points share this: the post-exhaustion picker (`manuallyPicking`,
   * reachable only once `finishPlaybackFailure` has run — the automatic
   * cascade is never interrupted while it still has a candidate left to try)
   * and the in-player "Fontes" control, reachable once something is already
   * `selected()` and therefore only ever swapping a *finished, successful*
   * pick for a different one, never racing against it.
   */
  protected pickManually(stream: PlayableStream): void {
    this.manualPickMode = true;
    this.manuallyPicking.set(false);
    this.playbackError.set(false);
    this.stallResumeSeconds.set(this.videoPlayer()?.currentPositionSeconds() ?? null);
    this.resolving.set(true);
    this.promote(stream);
  }

  /** The promoted source opened, but contained a removal notice instead of the title. */
  protected onDecoyDetected(failedSrc: string): void {
    if (failedSrc !== this.playbackSrc()) return;
    const url = this.selected()?.url;
    if (url) {
      this.rejectedUrls.add(url);
      this.decoyCount += 1;
    }
    this.resumeRace();
  }

  protected onPlaybackError(failedSrc: string): void {
    if (failedSrc !== this.playbackSrc()) return;
    const url = this.selected()?.url;
    if (url) this.rejectedUrls.add(url);
    this.resumeRace();
  }

  /** A source that was genuinely playing stalled past recovery — fail over, but pick up where it died. */
  protected onPlaybackStalledOut(event: { src: string; positionSeconds: number }): void {
    if (event.src !== this.playbackSrc()) return;
    const url = this.selected()?.url;
    if (url) this.rejectedUrls.add(url);
    this.stallResumeSeconds.set(event.positionSeconds);
    this.resumeRace();
  }

  protected onPlaybackReady(playedSrc: string): void {
    if (playedSrc !== this.playbackSrc()) return;

    clearTimeout(this.playbackTimer);
    this.playbackTimer = undefined;
    this.race?.cancel();
    this.race = undefined;
    this.playbackError.set(false);
    this.triedEverySource.set(false);
    this.decoyRateLimited.set(false);
    this.confirmedStream.set(this.selected());
    this.stallResumeSeconds.set(null);
    // The veil comes down only here: the frame is decoding, so what the
    // element shows from now on is the film and not a source being probed.
    this.resolving.set(false);
  }

  /** Starts up to 16 muted media probes; the first one producing frames wins. */
  private startAttempts(first: PlayableStream): void {
    this.cancelAttempts();
    this.raceStarted = true;
    this.playbackError.set(false);
    this.triedEverySource.set(false);
    this.decoyRateLimited.set(false);
    this.rejectedUrls.clear();
    this.timedOutUrls.clear();
    this.retriedTimeouts = false;
    this.launchedUrls.clear();
    this.decoyCount = 0;
    this.stallResumeSeconds.set(null);

    const seen = new Set<string>();
    const candidates = [first, ...this.streams().filter((stream) => stream.key !== first.key)]
      .filter((stream) => {
        if (!stream.playable || !stream.url || seen.has(stream.url)) return false;
        seen.add(stream.url);
        return true;
      });

    this.candidateCount.set(candidates.length);
    this.attemptAt.set(0);
    this.launchRace(candidates);
  }

  private launchRace(
    candidates: PlayableStream[],
    concurrency = STREAM_PROBE_CONCURRENCY,
    timeoutMs = STREAM_PROBE_TIMEOUT,
  ): void {
    this.race?.cancel();
    if (!candidates.length) {
      this.onRaceExhausted();
      return;
    }

    this.resolving.set(true);
    this.race = new CandidateRace(
      candidates,
      concurrency,
      (stream, settle) => this.probeStream(stream, settle, timeoutMs),
      {
        started: (stream) => {
          if (stream.url) this.launchedUrls.add(stream.url);
          this.attemptAt.set(this.launchedUrls.size);
        },
        rejected: (stream, outcome) => {
          if (!stream.url) return;
          if (outcome === 'timeout') {
            this.timedOutUrls.add(stream.url);
            return;
          }
          this.rejectedUrls.add(stream.url);
          if (outcome === 'decoy') this.decoyCount += 1;
        },
        winner: (stream) => this.promote(stream),
        exhausted: () => this.onRaceExhausted(),
      },
    );
    this.race.start();
  }

  /**
   * A candidate that only timed out is ambiguous — a slow mirror or, more
   * often, bandwidth contention from the other 15 probes racing it — so it
   * gets exactly one more attempt, alone with more room, before being
   * written off for good. Only once that second pass also comes up empty is
   * playback declared to have exhausted every source.
   */
  private onRaceExhausted(): void {
    if (this.retriedTimeouts || !this.timedOutUrls.size) {
      this.finishPlaybackFailure(true);
      return;
    }

    this.retriedTimeouts = true;
    const retryUrls = new Set(this.timedOutUrls);
    this.timedOutUrls.clear();
    const remaining = this.playableCandidates().filter(
      (stream) => !!stream.url && retryUrls.has(stream.url),
    );
    this.launchRace(remaining, RETRY_PROBE_CONCURRENCY, RETRY_PROBE_TIMEOUT);
  }

  /**
   * A muted off-screen video performs the same container/codec/network work as
   * the visible player. `playing` is the success line: an HTTP 200 or metadata
   * alone can still be an unsupported MKV or a two-minute removal notice.
   */
  private probeStream(
    stream: PlayableStream,
    settle: (outcome: ProbeOutcome) => void,
    timeoutMs = STREAM_PROBE_TIMEOUT,
  ): ProbeHandle {
    const media = document.createElement('video');
    media.muted = true;
    media.defaultMuted = true;
    media.volume = 0;
    media.preload = 'auto';
    media.playsInline = true;
    media.setAttribute('playsinline', '');
    media.setAttribute('aria-hidden', 'true');
    media.style.cssText =
      'position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;opacity:0;pointer-events:none';

    let autoplayBlocked = false;
    const onMetadata = () => {
      if (isLikelyRemovalNotice(media.duration, this.expectedRuntimeMinutes())) settle('decoy');
    };
    const onPlaying = () => settle('ready');
    const onCanPlay = () => {
      // If this browser refuses even muted autoplay, canplay is the strongest
      // probe available; the visible player will expose its manual play button.
      if (autoplayBlocked) settle('ready');
    };
    const onError = () => settle('failed');
    const timer = setTimeout(() => settle('timeout'), timeoutMs);

    media.addEventListener('loadedmetadata', onMetadata);
    media.addEventListener('playing', onPlaying);
    media.addEventListener('canplay', onCanPlay);
    media.addEventListener('error', onError);
    document.body.appendChild(media);
    media.src = this.attemptUrl(stream.url!, 'probe');
    media.load();
    void media.play().catch((error: unknown) => {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        autoplayBlocked = true;
        if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) settle('ready');
        return;
      }
      settle('failed');
    });

    return {
      cancel: () => {
        clearTimeout(timer);
        media.removeEventListener('loadedmetadata', onMetadata);
        media.removeEventListener('playing', onPlaying);
        media.removeEventListener('canplay', onCanPlay);
        media.removeEventListener('error', onError);
        media.pause();
        media.removeAttribute('src');
        media.load();
        media.remove();
      },
    };
  }

  /** Hands the race winner to the full player, which owns playback from here. */
  private promote(stream: PlayableStream): void {
    this.race = undefined;
    const attemptSrc = this.attemptUrl(stream.url!, 'play');
    this.selected.set(stream);
    this.playbackSrc.set(attemptSrc);

    clearTimeout(this.playbackTimer);
    this.playbackTimer = setTimeout(
      () => this.onPlaybackError(attemptSrc),
      STREAM_PROBE_TIMEOUT,
    );
  }

  /**
   * If promotion itself fails, race every candidate not conclusively
   * rejected — unless the failed pick was a manual one, in which case this
   * returns the user to the picker instead of silently handing them a
   * different automatic choice. `queue`/`rejectedUrls` are left untouched
   * either way, so re-opening the picker still shows the full candidate
   * list rather than one that has quietly shrunk.
   */
  private resumeRace(): void {
    clearTimeout(this.playbackTimer);
    this.playbackTimer = undefined;
    this.selected.set(null);
    this.playbackSrc.set(null);

    if (this.manualPickMode) {
      this.resolving.set(false);
      this.playbackError.set(true);
      this.manuallyPicking.set(true);
      return;
    }

    const remaining = this.playableCandidates().filter(
      (stream) => !!stream.url && !this.rejectedUrls.has(stream.url),
    );
    this.launchRace(remaining);
  }

  private finishPlaybackFailure(triedAll: boolean): void {
    clearTimeout(this.playbackTimer);
    this.playbackTimer = undefined;
    this.race?.cancel();
    this.race = undefined;
    this.resolving.set(false);
    this.playbackError.set(true);
    this.triedEverySource.set(triedAll);
    this.decoyRateLimited.set(this.decoyCount >= 3);
    this.videoPlayer()?.showFailure();
  }

  private cancelAttempts(): void {
    clearTimeout(this.playbackTimer);
    this.playbackTimer = undefined;
    this.race?.cancel();
    this.race = undefined;
    this.resolving.set(false);
    this.attemptAt.set(0);
    this.candidateCount.set(0);
  }

  private playableCandidates(): PlayableStream[] {
    const seen = new Set<string>();
    return this.streams().filter((stream) => {
      if (!stream.playable || !stream.url || seen.has(stream.url)) return false;
      seen.add(stream.url);
      return true;
    });
  }

  private attemptUrl(url: string, kind: 'probe' | 'play'): string {
    const separator = url.includes('#') ? '&' : '#';
    return `${url}${separator}mdblist_${kind}=${++this.attemptSerial}`;
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
    this.subtitleChosenByUser = true;
    this.applySubtitle(this.subtitleOptions().find((s) => s.key === key) ?? null);
  }

  /** The in-player chooser — the only way to pick a subtitle once fullscreen. */
  protected onSubtitleSelect(option: SubtitleOption | null): void {
    this.subtitleChosenByUser = true;
    this.applySubtitle(option);
  }

  private applySubtitle(option: SubtitleOption | null): void {
    this.clearSubtitle();
    if (!option) return;

    this.subtitle.set(option);
    this.subtitleBusy.set(true);

    this.subtitleRequest = this.stremio.subtitleTrack(option).subscribe({
      next: (url) => {
        this.subtitleRequest = undefined;
        this.subtitleBusy.set(false);
        this.subtitleUrl.set(url);
      },
      error: (error: unknown) => {
        this.subtitleRequest = undefined;
        this.subtitleBusy.set(false);
        this.subtitleError.set(subtitleFailureMessage(error));
      },
    });
  }

  private clearSubtitle(): void {
    this.subtitleRequest?.unsubscribe();
    this.subtitleRequest = undefined;
    this.revoke();
    this.subtitle.set(null);
    this.subtitleUrl.set(null);
    this.subtitleError.set(null);
    this.subtitleBusy.set(false);
  }

  private resetSubtitleContext(): void {
    this.subtitleChosenByUser = false;
    this.autoSelectedForStream = null;
    this.confirmedStream.set(null);
    this.clearSubtitle();
  }

  private revoke(): void {
    const url = this.subtitleUrl();
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Says what actually went wrong with a subtitle.
 *
 * This used to be a single fixed sentence blaming CORS, which was a guess
 * dressed as a diagnosis — and a wrong one. The host these files come from
 * (`subs5.strem.io`) does send `Access-Control-Allow-Origin: *`, so a
 * cross-origin read of it succeeds; the message sent everyone hunting a
 * browser-security problem that was not there, while the real failure — a
 * refused status, a dropped connection, an unreadable file — went unnamed.
 *
 * `status === 0` is the one case where the old text was right: that is what
 * Angular reports when the browser blocks the request before any response
 * exists, which does mean CORS, an offline tab or a blocked host.
 */
function subtitleFailureMessage(error: unknown): string {
  const tail = ' Tente outra legenda da lista.';

  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return 'O navegador bloqueou o download da legenda — pode ser falta de conexão ou uma ' +
        'restrição do servidor que a hospeda.' + tail;
    }
    return `O servidor recusou o download da legenda (HTTP ${error.status}).${tail}`;
  }

  // Anything that is not an HTTP failure got here from the decode/convert
  // step, i.e. the file downloaded fine and was not a subtitle this player
  // could read.
  return 'A legenda foi baixada, mas o arquivo não pôde ser lido.' + tail;
}
