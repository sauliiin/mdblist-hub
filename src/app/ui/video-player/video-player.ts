import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input,
  output, signal, viewChild,
} from '@angular/core';

/** What the settings menu offers, in YouTube's own steps. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Idle time before the controls fade out during playback. */
const HIDE_AFTER = 2600;
/** How often a playing session refreshes its stored point on mdblist. */
const HEARTBEAT = 60_000;

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
    '[class.theater]': 'theater()',
  },
})
export class VideoPlayer {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  readonly src = input.required<string>();
  /** A `blob:` URL of a WebVTT file, or null when no subtitle is loaded. */
  readonly subtitleUrl = input<string | null>(null);
  readonly subtitleLabel = input<string>('Legenda');
  readonly subtitleLang = input<string>('pt');
  readonly theater = input(false);
  /** Shown over the top edge in fullscreen, where the page header is gone. */
  readonly mediaTitle = input<string>('');
  readonly mediaSubtitle = input<string | null>(null);

  readonly theaterChange = output<boolean>();
  readonly playbackError = output<void>();

  /** Where to pick up, 0–100. Applied once, on the first metadata load. */
  readonly resumeAt = input<number | null>(null);

  /** Go straight to fullscreen when a source is handed over. */
  readonly autoFullscreen = input(false);

  /** Drives scrobbling; `progress` is 0–100. */
  readonly playbackState = output<{ action: 'start' | 'pause' | 'stop'; progress: number }>();

  private readonly media = viewChild<ElementRef<HTMLVideoElement>>('media');
  private readonly track = viewChild<ElementRef<HTMLDivElement>>('track');

  protected readonly playing = signal(false);
  protected readonly waiting = signal(false);
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
  protected readonly controls = signal(true);

  /** Where the pointer sits over the scrub bar, for the time bubble. */
  protected readonly hoverRatio = signal<number | null>(null);
  private readonly scrubbing = signal(false);

  /** Transient "+10s" / "−10s" badge after a seek shortcut. */
  protected readonly seekFlash = signal<string | null>(null);

  protected readonly speeds = SPEEDS;

  private hideTimer?: ReturnType<typeof setTimeout>;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private beat?: ReturnType<typeof setInterval>;
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
    // A new source is a new title: reset everything the old one left behind.
    effect(() => {
      this.src();
      this.currentTime.set(0);
      this.duration.set(0);
      this.buffered.set(0);
      this.ended.set(false);
      this.settingsOpen.set(false);
      this.resumed = false;
      this.show();

      // Fullscreen needs transient user activation. The click that picked the
      // source granted it moments ago and it lasts a few seconds, so asking
      // once this component has rendered still lands inside the window.
      if (this.autoFullscreen()) setTimeout(() => this.enterFullscreen());
    });

    inject(DestroyRef).onDestroy(() => this.stopHeartbeat());

    // The `<track>` element only exists once the template sees a URL, and it
    // renders disabled until something asks for it.
    effect(() => {
      this.subtitleUrl();
      this.captionsOn.set(true);
      setTimeout(() => this.applyCaptions());
    });

    effect(() => {
      const element = this.media()?.nativeElement;
      if (element) element.playbackRate = this.speed();
    });
  }

  // ------------------------------------------------------------ playback

  protected togglePlay(): void {
    const element = this.media()?.nativeElement;
    if (!element) return;

    if (element.paused) void element.play().catch(() => this.playbackError.emit());
    else element.pause();
  }

  protected onPlay(): void {
    this.playing.set(true);
    this.ended.set(false);
    this.scheduleHide();
    this.report('start');
    this.startHeartbeat();
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

  // --------------------------------------------------------------- chrome

  protected setSpeed(value: number): void {
    this.speed.set(value);
    this.settingsOpen.set(false);
  }

  protected toggleTheater(): void {
    this.theaterChange.emit(!this.theater());
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
    this.fullscreen.set(document.fullscreenElement === this.host.nativeElement);
  }

  /** Any pointer activity brings the controls back and restarts the countdown. */
  protected wake(): void {
    this.show();
    this.scheduleHide();
  }

  protected onLeave(): void {
    if (this.playing() && !this.settingsOpen()) this.controls.set(false);
  }

  private show(): void {
    this.controls.set(true);
    clearTimeout(this.hideTimer);
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    if (!this.playing()) return;

    this.hideTimer = setTimeout(() => {
      if (!this.settingsOpen() && !this.scrubbing()) this.controls.set(false);
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
    const key = event.key.toLowerCase();
    const handled = true;

    switch (key) {
      case ' ':
      case 'k': this.togglePlay(); break;
      case 'arrowright': this.seekBy(5); break;
      case 'arrowleft': this.seekBy(-5); break;
      case 'l': this.seekBy(10); break;
      case 'j': this.seekBy(-10); break;
      case 'arrowup': this.nudgeVolume(0.05); break;
      case 'arrowdown': this.nudgeVolume(-0.05); break;
      case 'm': this.toggleMute(); break;
      case 'f': this.toggleFullscreen(); break;
      case 't': this.toggleTheater(); break;
      case 'c': this.toggleCaptions(); break;
      case 'home': this.seekTo(0); break;
      case 'end': this.seekTo(1); break;
      default:
        if (/^[0-9]$/.test(key)) this.seekTo(Number(key) / 10);
        else return;
    }

    if (handled) {
      event.preventDefault();
      this.wake();
    }
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
