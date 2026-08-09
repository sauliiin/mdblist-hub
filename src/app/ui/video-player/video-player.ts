import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input,
  output, signal, viewChild,
} from '@angular/core';
import { SubtitleOption } from '../../core/stremio/models';
import { TvService } from '../../core/tv/tv.service';
import { isLikelyRemovalNotice } from './decoy-detector';

/** What the settings menu offers, in YouTube's own steps. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Idle time before the controls fade out during playback. */
const HIDE_AFTER = 2600;
/** How often a playing session refreshes its stored point on mdblist. */
const HEARTBEAT = 60_000;

/** Cue line position (percent from the top) with the control bar hidden. */
const SUBTITLE_LINE_BASE = 90;
/** Raised further while the control bar is visible, so cues clear it. */
const SUBTITLE_LINE_LIFTED = 78;

/**
 * A YouTube-shaped player around a plain `<video>`.
 *
 * The native `controls` attribute is deliberately off: the browser's own bar
 * cannot be styled, differs per browser, and has no room for the things this
 * page needs (captions the addon supplied, playback speed, theater mode). So
 * everything below drives the media element directly.
 */
@Component({
  selector: 'app-video-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './video-player.html',
  styleUrl: './video-player.scss',
  host: {
    '(pointermove)': 'wake()',
    '(pointerleave)': 'onLeave()',
    '[class.idle]': 'playing() && !controls()',
  },
})
export class VideoPlayer {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly tv = inject(TvService);

  readonly src = input.required<string>();
  /** A `blob:` URL of a WebVTT file, or null when no subtitle is loaded. */
  readonly subtitleUrl = input<string | null>(null);
  readonly subtitleLabel = input<string>('Legenda');
  readonly subtitleLang = input<string>('pt');

  /**
   * The subtitle chooser lives here, not just in the page around the player,
   * because fullscreen — the normal way to watch on a TV or a phone — hides
   * everything outside this component. Without it, picking a language would
   * only be possible windowed.
   */
  readonly subtitleOptions = input<SubtitleOption[]>([]);
  readonly subtitleActiveKey = input<string | null>(null);
  readonly subtitleLoading = input(false);
  readonly subtitleError = input<string | null>(null);
  /** `null` means "turn subtitles off", same as the sidebar's own dropdown. */
  readonly subtitleSelect = output<SubtitleOption | null>();
  /** Shown over the top edge in fullscreen, where the page header is gone. */
  readonly mediaTitle = input<string>('');
  readonly mediaSubtitle = input<string | null>(null);
  /** Fanart shown behind the title until the first video frame starts playing. */
  readonly mediaBackdrop = input<string | null>(null);

  readonly playbackError = output<string>();
  readonly playbackReady = output<string>();

  /**
   * A source that opened fine but is not the title — see
   * [isLikelyRemovalNotice]. Separate from [playbackError] because the page has
   * to remember *which* url this was before moving on: the cascade laps the
   * queue twice, and a decoy is still perfectly playable the second time round.
   */
  readonly decoyDetected = output<string>();

  /** Where to pick up, 0–100. Applied once, on the first metadata load. */
  readonly resumeAt = input<number | null>(null);

  /**
   * How long this title is supposed to run, in minutes, from the metadata.
   * Null disables the decoy check in [onLoadedMetadata] rather than letting
   * it guess.
   */
  readonly expectedRuntimeMinutes = input<number | null>(null);

  /** Go straight to fullscreen when a source is handed over. */
  readonly autoFullscreen = input(false);

  /** Drives scrobbling; `progress` is 0–100. */
  readonly playbackState = output<{ action: 'start' | 'pause' | 'stop'; progress: number }>();

  private readonly media = viewChild<ElementRef<HTMLVideoElement>>('media');
  private readonly track = viewChild<ElementRef<HTMLDivElement>>('track');
  private readonly trackEl = viewChild<ElementRef<HTMLTrackElement>>('trackEl');
  private readonly captionsButton = viewChild<ElementRef<HTMLButtonElement>>('captionsButton');
  private readonly settingsButton = viewChild<ElementRef<HTMLButtonElement>>('settingsButton');

  protected readonly playing = signal(false);
  protected readonly waiting = signal(false);
  /** Keeps the cinematic opening visible until playback truly starts. */
  protected readonly opening = signal(true);
  protected readonly backdropFailed = signal(false);
  protected readonly ended = signal(false);
  protected readonly currentTime = signal(0);
  protected readonly duration = signal(0);
  protected readonly buffered = signal(0);
  protected readonly volume = signal(1);
  protected readonly muted = signal(false);
  protected readonly speed = signal(1);
  protected readonly captionsOn = signal(true);
  protected readonly fullscreen = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly captionsMenuOpen = signal(false);
  protected readonly controls = signal(true);
  protected readonly stretch = signal(false);

  /** Seconds shifted from the addon's original timing — negative moves cues earlier. */
  protected readonly subtitleOffset = signal(0);

  /** Where the pointer sits over the scrub bar, for the time bubble. */
  protected readonly hoverRatio = signal<number | null>(null);
  private readonly scrubbing = signal(false);

  /** Transient "+10s" / "−10s" badge after a seek shortcut. */
  protected readonly seekFlash = signal<string | null>(null);

  protected readonly speeds = SPEEDS;

  private hideTimer?: ReturnType<typeof setTimeout>;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private beat?: ReturnType<typeof setInterval>;
  /** Prevents unrelated signal changes from resetting an already-playing source. */
  private currentSrc: string | null = null;
  /** The resume point is applied once per source, not on every metadata load. */
  private resumed = false;

  protected readonly progress = computed(() => {
    const total = this.duration();
    return total ? Math.min(1, this.currentTime() / total) : 0;
  });

  protected readonly bufferedRatio = computed(() => {
    const total = this.duration();
    return total ? Math.min(1, this.buffered() / total) : 0;
  });

  /** While scrubbing, the bubble follows the pointer instead of the clock. */
  protected readonly scrubRatio = computed(() =>
    this.scrubbing() ? this.hoverRatio() ?? this.progress() : this.progress(),
  );

  protected readonly elapsedLabel = computed(() => format(this.currentTime()));
  protected readonly durationLabel = computed(() => format(this.duration()));
  protected readonly hoverLabel = computed(() => {
    const ratio = this.hoverRatio();
    return ratio === null ? '' : format(ratio * this.duration());
  });

  protected readonly hasCaptions = computed(() => !!this.subtitleUrl());

  protected readonly volumeIcon = computed(() => {
    if (this.muted() || !this.volume()) return 'mute';
    return this.volume() < 0.5 ? 'low' : 'high';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    // A new source resets everything the old one left behind.
    effect(() => {
      const src = this.src();
      const sourceChanged = src !== this.currentSrc;

      if (sourceChanged) {
        this.currentSrc = src;
        this.stopHeartbeat();
        this.currentTime.set(0);
        this.duration.set(0);
        this.buffered.set(0);
        this.playing.set(false);
        this.opening.set(true);
        this.backdropFailed.set(false);
        this.waiting.set(false);
        this.ended.set(false);
        this.settingsOpen.set(false);
        this.resumed = false;
        this.show();
      }

      // Fullscreen needs transient user activation. The click that picked the
      // source granted it moments ago and it lasts a few seconds, so asking
      // once this component has rendered still lands inside the window.
      if (this.autoFullscreen()) setTimeout(() => this.enterFullscreen());

      // The `autoplay` attribute only fires on an element freshly inserted
      // into the DOM — the case when this component is created for the first
      // pick. Choosing a *different* source while this same instance stays
      // mounted only changes the `src` property, which the spec does not
      // treat as a reason to restart playback on its own. Calling `play()`
      // explicitly covers both paths.
      if (sourceChanged) {
        setTimeout(() => {
          void this.media()?.nativeElement.play().catch((error: unknown) => {
            if (this.src() !== src || this.playing()) return;

            const name = error instanceof DOMException ? error.name : '';
            // A newer load or play request superseded this one; its own event
            // will decide when the opening has actually finished.
            if (name === 'AbortError') return;

            if (name === 'NotAllowedError') {
              // Autoplay policy is not a broken source. Reveal a manual retry.
              this.opening.set(false);
              return;
            }

            this.onMediaError(src);
          });
        });
      }
    });

    destroyRef.onDestroy(() => this.stopHeartbeat());

    // Android TV's WebView frequently sends DPAD_CENTER to the document after
    // fullscreen has moved focus away from the original `.shell`. Capture it
    // here so OK and the D-pad keep working even when no element owns focus.
    const onRemoteKey = (event: KeyboardEvent) => {
      if (!this.tv.isTv()) return;

      const active = document.activeElement;
      const ownsFullscreen = document.fullscreenElement === this.host.nativeElement;
      if (!ownsFullscreen && (!active || !this.host.nativeElement.contains(active))) return;

      this.onKey(event);
    };
    document.addEventListener('keydown', onRemoteKey, true);
    destroyRef.onDestroy(() => document.removeEventListener('keydown', onRemoteKey, true));

    // The `<track>` element only exists once the template sees a URL, and it
    // renders disabled until something asks for it.
    effect(() => {
      this.subtitleUrl();
      this.captionsOn.set(true);
      this.subtitleOffset.set(0);
      setTimeout(() => this.applyCaptions());
    });

    effect(() => {
      const element = this.media()?.nativeElement;
      if (element) element.playbackRate = this.speed();
    });

    // Cues cannot be repositioned through CSS — a `::cue` box is placed by
    // its own `line`/`align` properties, which is why this tracks the same
    // `controls` visibility the chrome below fades on, and pushes the cue up
    // out from under the control bar for exactly as long as that bar is on
    // screen.
    effect(() => {
      this.positionCues(this.controls() ? SUBTITLE_LINE_LIFTED : SUBTITLE_LINE_BASE);
    });
  }

  // ------------------------------------------------------------ playback

  protected togglePlay(): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    // While autoplay is buffering, another OK/click must not pause the load.
    // If autoplay was blocked the element is paused, so the same gesture still retries it.
    if (this.opening() && !element.paused) return;

    if (element.paused) void element.play().catch(() => this.onMediaError());
    else element.pause();
  }

  protected onPlay(): void {
    this.playing.set(true);
    this.ended.set(false);
    this.scheduleHide();
    this.report('start');
    this.startHeartbeat();
  }

  /** `playing`, unlike `play`, means the browser can present real frames. */
  protected onPlaying(): void {
    this.waiting.set(false);
    this.opening.set(false);
    this.playbackReady.emit(this.currentSrc || this.src());
  }

  protected onPause(): void {
    this.playing.set(false);
    this.show();
    this.stopHeartbeat();
    // The `ended` event fires a pause too; that one is a stop, not a pause.
    if (!this.ended()) this.report('pause');
  }

  protected onEnded(): void {
    this.playing.set(false);
    this.ended.set(true);
    this.show();
    this.stopHeartbeat();
    this.report('stop');
  }

  protected onTimeUpdate(): void {
    const element = this.media()?.nativeElement;
    if (!element || this.scrubbing()) return;

    this.currentTime.set(element.currentTime);
    this.readBuffered(element);
  }

  protected onLoadedMetadata(): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    // A lot of dead mirrors answer with a 30-second "this file has been
    // removed" clip instead of the film. It opens, decodes and plays without
    // a single error, so it is the one failure the source cascade cannot see
    // by waiting for something to go wrong — every other dead source refuses
    // to open, while this one succeeds at being the wrong thing. Reported as
    // a playback error so it takes the same path to the next candidate.
    if (isLikelyRemovalNotice(element.duration, this.expectedRuntimeMinutes())) {
      // `src()` and not `element.currentSrc`: the page matches this against
      // the exact string it handed over, attempt fragment and all, and drops
      // anything that does not match as a stale event from a replaced source.
      // The browser normalises `currentSrc`, so reporting that was reporting
      // a url the page could never recognise — the event was discarded and
      // the decoy played on.
      this.decoyDetected.emit(this.src());
      return;
    }

    this.duration.set(isFinite(element.duration) ? element.duration : 0);
    element.playbackRate = this.speed();
    this.applyCaptions();

    // Resuming has to wait for the duration: the stored point is a percentage,
    // and there is nothing to turn it into seconds before metadata arrives.
    const resume = this.resumeAt();
    if (!this.resumed && resume && resume > 0 && element.duration) {
      this.resumed = true;
      element.currentTime = (resume / 100) * element.duration;
      this.currentTime.set(element.currentTime);
    }
  }

  protected onMediaError(failedSrc?: string): void {
    this.playing.set(false);
    this.waiting.set(false);
    this.stopHeartbeat();
    this.show();

    // Keep the opening artwork mounted while Player switches to the next
    // source. Only `showFailure()` removes it after every retry is exhausted.
    const elementSrc = this.media()?.nativeElement.currentSrc;
    this.playbackError.emit(failedSrc || elementSrc || this.currentSrc || this.src());
  }

  /** Called by the page only after every source and retry has failed. */
  showFailure(): void {
    const element = this.media()?.nativeElement;
    element?.pause();
    if (element) {
      element.removeAttribute('src');
      element.load();
    }

    this.opening.set(false);
    this.waiting.set(false);
    this.show();
    if (document.fullscreenElement === this.host.nativeElement) void document.exitFullscreen();
  }

  // ----------------------------------------------------------- scrobble

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Keeps the stored point close to reality while a long film plays, so a
    // browser that is closed without warning still resumes near the right spot.
    this.beat = setInterval(() => this.report('start'), HEARTBEAT);
  }

  private stopHeartbeat(): void {
    clearInterval(this.beat);
    this.beat = undefined;
  }

  private report(action: 'start' | 'pause' | 'stop'): void {
    const progress = this.progress() * 100;
    if (!this.duration()) return;

    this.playbackState.emit({ action, progress });
  }

  /** Lets the page report a stop when the player is torn down or left. */
  reportStop(): void {
    this.stopHeartbeat();
    if (this.duration()) this.report('stop');
  }

  private readBuffered(element: HTMLVideoElement): void {
    const ranges = element.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= element.currentTime && element.currentTime <= ranges.end(i)) {
        this.buffered.set(ranges.end(i));
        return;
      }
    }
  }

  // ---------------------------------------------------------------- seek

  protected seekBy(seconds: number): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    element.currentTime = clamp(element.currentTime + seconds, 0, element.duration || 0);
    this.currentTime.set(element.currentTime);
    this.flash(`${seconds > 0 ? '+' : '−'}${Math.abs(seconds)}s`);
  }

  protected seekTo(ratio: number): void {
    const element = this.media()?.nativeElement;
    if (!element || !element.duration) return;

    element.currentTime = clamp(ratio, 0, 1) * element.duration;
    this.currentTime.set(element.currentTime);
  }

  protected onScrubStart(event: PointerEvent): void {
    const bar = this.track()?.nativeElement;
    if (!bar) return;

    bar.setPointerCapture(event.pointerId);
    this.scrubbing.set(true);
    this.hoverRatio.set(this.ratioAt(event));
  }

  protected onScrubMove(event: PointerEvent): void {
    const ratio = this.ratioAt(event);
    this.hoverRatio.set(ratio);

    // Seeking live while dragging is what makes the bar feel attached to the
    // video; the `scrubbing` flag keeps `timeupdate` from fighting the pointer.
    if (this.scrubbing()) this.seekTo(ratio);
  }

  protected onScrubEnd(event: PointerEvent): void {
    if (!this.scrubbing()) return;

    this.track()?.nativeElement.releasePointerCapture(event.pointerId);
    this.seekTo(this.ratioAt(event));
    this.scrubbing.set(false);
  }

  protected onScrubLeave(): void {
    if (!this.scrubbing()) this.hoverRatio.set(null);
  }

  private ratioAt(event: PointerEvent): number {
    const bar = this.track()?.nativeElement;
    if (!bar) return 0;

    const box = bar.getBoundingClientRect();
    return clamp((event.clientX - box.left) / box.width, 0, 1);
  }

  // -------------------------------------------------------------- volume

  protected toggleMute(): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    element.muted = !element.muted;
    this.muted.set(element.muted);
  }

  protected onVolume(event: Event): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    const value = Number((event.target as HTMLInputElement).value);
    element.volume = value;
    element.muted = value === 0;
    this.volume.set(value);
    this.muted.set(element.muted);
  }

  protected onVolumeChange(): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    this.volume.set(element.volume);
    this.muted.set(element.muted);
  }

  // ------------------------------------------------------------ captions

  protected toggleCaptions(): void {
    if (!this.hasCaptions()) return;
    this.captionsOn.set(!this.captionsOn());
    this.applyCaptions();
  }

  /** Drives `TextTrack.mode`, which is the only way to show or hide a cue. */
  private applyCaptions(): void {
    const tracks = this.media()?.nativeElement.textTracks;
    if (!tracks?.length) return;

    for (let i = 0; i < tracks.length; i++) {
      const last = i === tracks.length - 1;
      tracks[i].mode = last && this.captionsOn() ? 'showing' : 'disabled';
    }
  }

  /** Picking from the in-player menu; fetching and converting stays with the page. */
  protected pickSubtitle(option: SubtitleOption | null): void {
    this.subtitleSelect.emit(option);
    this.captionsMenuOpen.set(false);
    if (this.tv.isTv()) setTimeout(() => this.captionsButton()?.nativeElement.focus());
  }

  protected toggleCaptionsMenu(): void {
    const open = !this.captionsMenuOpen();
    this.captionsMenuOpen.set(open);
    this.settingsOpen.set(false);
    if (open && this.tv.isTv()) setTimeout(() => this.focusMenuItem('.captions-menu'));
  }

  /**
   * Shifts every cue of the loaded track by `deltaSeconds`, for a subtitle that
   * drifts against a release the addon did not time it for.
   *
   * `TextTrackCue.startTime`/`endTime` are live and mutable — editing them
   * in place is the whole mechanism; there is no separate "apply" step. This
   * only touches whatever is loaded *right now*, so switching to a different
   * subtitle starts fresh rather than inheriting the old drift.
   */
  protected adjustSync(deltaSeconds: number): void {
    const cues = this.trackEl()?.nativeElement.track?.cues;
    if (!cues?.length) return;

    for (let i = 0; i < cues.length; i++) {
      cues[i].startTime += deltaSeconds;
      cues[i].endTime += deltaSeconds;
    }

    this.subtitleOffset.update((v) => Math.round((v + deltaSeconds) * 10) / 10);
  }

  protected resetSync(): void {
    const current = this.subtitleOffset();
    if (current) this.adjustSync(-current);
  }

  /**
   * Sets every cue's vertical position, in percent down the video — `90` is
   * a small margin above a plain bottom edge, `78` clears the custom control
   * bar this player draws (see the effect below).
   *
   * `snapToLines = false` is required before a plain number in `line` is
   * read as a percentage rather than an integer row count, and `lineAlign =
   * 'end'` anchors that percentage to the box's *bottom* edge — with the
   * default `'start'` anchor a multi-line cue grows downward from the
   * percentage point instead of sitting above it, which on a two-line cue
   * pushes the second line noticeably lower than intended.
   */
  private positionCues(percentFromTop: number): void {
    const cues = this.trackEl()?.nativeElement.track?.cues;
    if (!cues?.length) return;

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] as VTTCue;
      cue.snapToLines = false;
      cue.line = percentFromTop;
      cue.lineAlign = 'end';
      cue.align = 'center';
    }
  }

  /** Cues exist only once the browser has finished parsing the VTT resource. */
  protected onSubtitleTrackLoad(): void {
    this.positionCues(this.controls() ? SUBTITLE_LINE_LIFTED : SUBTITLE_LINE_BASE);
  }

  // --------------------------------------------------------------- chrome

  protected setSpeed(value: number): void {
    this.speed.set(value);
    this.settingsOpen.set(false);
    if (this.tv.isTv()) setTimeout(() => this.settingsButton()?.nativeElement.focus());
  }

  protected toggleSettingsMenu(): void {
    const open = !this.settingsOpen();
    this.settingsOpen.set(open);
    this.captionsMenuOpen.set(false);
    if (open && this.tv.isTv()) setTimeout(() => this.focusMenuItem('.settings .menu'));
  }

  protected toggleStretch(): void {
    this.stretch.set(!this.stretch());
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else this.enterFullscreen();
  }

  /**
   * Refusal is normal and harmless — the browser may have decided the click is
   * too far in the past — so the failure just leaves the player windowed.
   */
  enterFullscreen(): void {
    if (document.fullscreenElement) return;

    void this.host.nativeElement.requestFullscreen?.().catch(() => undefined);
    this.focusShell();
  }

  /** Puts the remote's focus inside the player, so arrows seek rather than roam. */
  private focusShell(): void {
    this.host.nativeElement.querySelector<HTMLElement>('.shell')?.focus({ preventScroll: true });
  }

  protected onFullscreenChange(): void {
    const isFullscreen = document.fullscreenElement === this.host.nativeElement;
    this.fullscreen.set(isFullscreen);
    if (isFullscreen) setTimeout(() => this.focusShell());
  }

  /** Any pointer activity brings the controls back and restarts the countdown. */
  protected wake(): void {
    this.show();
    this.scheduleHide();
  }

  protected onLeave(): void {
    if (this.playing() && !this.settingsOpen() && !this.captionsMenuOpen()) {
      this.controls.set(false);
    }
  }

  private show(): void {
    this.controls.set(true);
    clearTimeout(this.hideTimer);
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    if (!this.playing()) return;

    this.hideTimer = setTimeout(() => {
      const focusedChrome = document.activeElement instanceof HTMLElement &&
        !!document.activeElement.closest('[data-player-control], .menu');
      if (!this.settingsOpen() && !this.captionsMenuOpen() && !this.scrubbing() && !focusedChrome) {
        this.controls.set(false);
      }
    }, HIDE_AFTER);
  }

  private flash(text: string): void {
    this.seekFlash.set(text);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.seekFlash.set(null), 700);
  }

  // ------------------------------------------------------------ keyboard

  /**
   * The shortcuts YouTube trained everyone on. Bound on the host rather than
   * the document so the season and subtitle pickers beside the player keep
   * their own arrow and space keys.
   */
  protected onKey(event: KeyboardEvent): void {
    const key = remoteKey(event);

    // The first OK after the chrome faded only wakes it. This check comes
    // before focused controls because Android can leave focus on a hidden
    // button after the inactivity timer runs.
    if (key === 'enter' && !this.controls()) {
      this.consume(event);
      this.wake();
      if (this.tv.isTv()) {
        setTimeout(() => this.focusPlayerControl(0));
      } else {
        this.focusShell();
      }
      return;
    }

    if (this.handleMenuKey(event, key)) return;
    if (this.handleControlKey(event, key)) return;

    switch (key) {
      /*
       * OK on a remote. The controls hide themselves after a couple of idle
       * seconds, and `wake()` was only ever wired to `pointermove` — an event
       * a remote never produces. So once they faded there was no way at all
       * to bring them back on a television.
       *
       * First press reveals them (the `wake()` at the end of this method does
       * that for every handled key); a second press, while they are already
       * up, plays or pauses. That is the behaviour every TV player uses.
       */
      case 'enter':
        if (this.controls()) this.togglePlay();
        break;
      case 'space':
      case 'k': this.togglePlay(); break;
      case 'arrowright': this.seekBy(5); break;
      case 'arrowleft': this.seekBy(-5); break;
      case 'l': this.seekBy(10); break;
      case 'j': this.seekBy(-10); break;
      case 'arrowup': this.nudgeVolume(0.05); break;
      case 'arrowdown':
        if (this.tv.isTv() && this.controls()) this.focusPlayerControl(0);
        else this.nudgeVolume(-0.05);
        break;
      case 'm': this.toggleMute(); break;
      case 'f': this.toggleFullscreen(); break;
      case 't': this.toggleStretch(); break;
      case 'c': this.toggleCaptions(); break;
      case 'home': this.seekTo(0); break;
      case 'end': this.seekTo(1); break;
      default:
        if (/^[0-9]$/.test(key)) this.seekTo(Number(key) / 10);
        else return;
    }

    this.consume(event);
    this.wake();
  }

  /** Up/down/OK navigation inside the open subtitle or speed menu. */
  private handleMenuKey(event: KeyboardEvent, key: string): boolean {
    const menu = this.host.nativeElement.querySelector<HTMLElement>('.menu');
    if (!menu) return false;

    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!items.length) return false;

    const active = document.activeElement as HTMLButtonElement | null;
    const index = items.indexOf(active!);

    if (key === 'arrowdown' || key === 'arrowup') {
      const step = key === 'arrowdown' ? 1 : -1;
      const next = index < 0
        ? (key === 'arrowdown' ? 0 : items.length - 1)
        : (index + step + items.length) % items.length;
      items[next].focus({ preventScroll: true });
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (key === 'enter' || key === 'space') {
      (items.includes(active!) ? active! : items[0]).click();
    } else if (key === 'arrowleft' || key === 'escape' || key === 'backspace') {
      const captions = this.captionsMenuOpen();
      this.captionsMenuOpen.set(false);
      this.settingsOpen.set(false);
      setTimeout(() => (captions
        ? this.captionsButton()?.nativeElement
        : this.settingsButton()?.nativeElement)?.focus());
    } else {
      return false;
    }

    this.consume(event);
    this.wake();
    return true;
  }

  /** Left/right chooses a player button; OK activates the chosen control. */
  private handleControlKey(event: KeyboardEvent, key: string): boolean {
    if (!this.tv.isTv()) return false;

    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLButtonElement>('[data-player-control]')
      : null;
    if (!active || !this.host.nativeElement.contains(active)) return false;

    if (key === 'arrowleft' || key === 'arrowright') {
      const controls = this.playerControls();
      const index = Math.max(0, controls.indexOf(active));
      const step = key === 'arrowright' ? 1 : -1;
      controls[(index + step + controls.length) % controls.length]?.focus({ preventScroll: true });
    } else if (key === 'enter' || key === 'space') {
      active.click();
    } else if (key === 'arrowup') {
      this.focusShell();
    } else if (key === 'arrowdown') {
      // Down on CC/settings opens that menu; on other controls it remains put.
      if (active === this.captionsButton()?.nativeElement ||
          active === this.settingsButton()?.nativeElement) active.click();
    } else {
      return false;
    }

    this.consume(event);
    this.wake();
    return true;
  }

  private playerControls(): HTMLButtonElement[] {
    return Array.from(
      this.host.nativeElement.querySelectorAll<HTMLButtonElement>('[data-player-control]:not(:disabled)'),
    );
  }

  private focusPlayerControl(index: number): void {
    this.playerControls()[index]?.focus({ preventScroll: true });
  }

  private focusMenuItem(selector: string): void {
    const menu = this.host.nativeElement.querySelector<HTMLElement>(selector);
    const selected = menu?.querySelector<HTMLButtonElement>('.menu-item.on');
    const first = menu?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (selected ?? first)?.focus({ preventScroll: true });
  }

  private consume(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  private nudgeVolume(delta: number): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    element.volume = clamp(element.volume + delta, 0, 1);
    element.muted = element.volume === 0;
    this.volume.set(element.volume);
    this.muted.set(element.muted);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Android DPAD key codes are used when WebView reports `Unidentified`. */
function remoteKey(event: KeyboardEvent): string {
  const named = event.key.toLowerCase();
  if (named && named !== 'unidentified') {
    if (named === ' ' || named === 'spacebar') return 'space';
    if (named === 'select' || named === 'accept' || named === 'dpad_center') return 'enter';
    return named;
  }

  switch (event.keyCode) {
    case 19: return 'arrowup';
    case 20: return 'arrowdown';
    case 21: return 'arrowleft';
    case 22: return 'arrowright';
    case 23:
    case 66: return 'enter';
    case 4: return 'backspace';
    default: return '';
  }
}

/** `1:02:03` past an hour, `2:03` below it — the way players have always done. */
function format(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
