import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { upscalePoster } from '../../core/api.config';
import { I18nPipe } from '../../core/i18n.service';
import { HoverPreviewService } from '../../core/hover-preview.service';
import { toTmdbType } from '../../core/models';
import { TrailerPreviewService } from '../../core/trailer-preview.service';
import { loadYouTubeIframeApi, YouTubePlayer } from '../../core/youtube-player';

/**
 * The Netflix-style floating card `MediaCard` opens after a 2s hover dwell —
 * mounted once at the app root (see `app.html`) rather than inside any row,
 * for the `content-visibility` reason documented on `HoverPreviewService`.
 */
@Component({
  selector: 'app-hover-preview-card',
  imports: [I18nPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hover-preview-card.html',
  styleUrl: './hover-preview-card.scss',
})
export class HoverPreviewCard {
  private readonly hoverPreview = inject(HoverPreviewService);
  private readonly trailerPreview = inject(TrailerPreviewService);

  protected readonly state = this.hoverPreview.state;
  private readonly trailerHost = viewChild<ElementRef<HTMLDivElement>>('trailerHost');

  protected readonly poster = computed(() => {
    const item = this.state()?.item;
    return item ? upscalePoster(item.poster, 'w342') : null;
  });

  protected readonly link = computed(() => {
    const item = this.state()?.item;
    return item ? ['/title', toTmdbType(item.mediatype), item.id] : [];
  });

  protected readonly watchLink = computed(() => {
    const item = this.state()?.item;
    return item ? ['/watch', toTmdbType(item.mediatype), item.id] : [];
  });

  /** `undefined` while unresolved, `null` once resolved with nothing found. */
  protected readonly trailerKey = computed(() => {
    const item = this.state()?.item;
    return item ? this.trailerPreview.get(item.mediatype, item.id) : undefined;
  });

  /** True once the player actually confirms playback — see the effect below. */
  protected readonly playing = signal(false);

  private player: YouTubePlayer | null = null;
  private playerKey: string | null = null;

  constructor() {
    // Only fetched once the dwell actually opens the card — the same
    // lazy-on-demand rule `LandscapeArtworkService` follows.
    effect(() => {
      const item = this.state()?.item;
      if (item) this.trailerPreview.request(item.mediatype, item.id);
    });

    /*
     * A plain `<iframe [src]="...?autoplay=1&mute=1">` is what the detail
     * page's own trailer modal uses, and that is fine there — it opens on a
     * deliberate click, so YouTube's own play button flashing for a moment
     * is a non-issue. Here it defeated the point: browsers honour that URL
     * param combination inconsistently, and a preview that sits on a
     * thumbnail with a play button is just a worse thumbnail. The IFrame
     * Player API is Google's own documented fix — create the player, then
     * call `mute()` and `playVideo()` explicitly from `onReady` instead of
     * trusting the query string alone.
     */
    effect(() => {
      const key = this.trailerKey();
      const host = this.trailerHost()?.nativeElement;

      if (!key || !host) {
        this.destroyPlayer();
        return;
      }
      if (this.playerKey === key) return;

      this.destroyPlayer();
      this.playerKey = key;

      loadYouTubeIframeApi().then(() => {
        // The preview may have moved on to a different title (or closed)
        // while the script was loading — a stale key means this load lost.
        if (this.playerKey !== key || !window.YT) return;

        this.player = new window.YT.Player(host, {
          videoId: key,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            mute: 0,
            controls: 0,
            loop: 1,
            playlist: key,
            modestbranding: 1,
            rel: 0,
            iv_load_policy: 3,
            disablekb: 1,
            fs: 0,
            playsinline: 1,
          },
          events: {
            onReady: (event) => {
              event.target.unMute();
              event.target.setVolume(100);
              event.target.playVideo();
              this.playing.set(true);
            },
          },
        });
      });
    });
  }

  protected onEnter(): void {
    this.hoverPreview.keepOpen();
  }

  protected onLeave(): void {
    this.hoverPreview.close();
  }

  private destroyPlayer(): void {
    this.player?.destroy();
    this.player = null;
    this.playerKey = null;
    this.playing.set(false);
  }
}
