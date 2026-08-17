import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { upscalePoster } from '../../core/api.config';
import { I18nPipe, translateGenre } from '../../core/i18n.service';
import { HoverPreviewService } from '../../core/hover-preview.service';
import { LandscapeArtworkService } from '../../core/landscape-artwork.service';
import { LibraryService } from '../../core/library.service';
import { MdbItem, formatYear, titleWithYear, toTmdbType } from '../../core/models';
import { PrefetchService } from '../../core/prefetch.service';
import { ThemePrefsService } from '../../core/theme-prefs.service';
import { TvService } from '../../core/tv/tv.service';

@Component({
  selector: 'app-media-card',
  imports: [I18nPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-card.html',
  styleUrl: './media-card.scss',
})
export class MediaCard implements OnDestroy {
  private readonly tv = inject(TvService);
  private readonly library = inject(LibraryService);
  private readonly prefetch = inject(PrefetchService);
  private readonly landscapeArt = inject(LandscapeArtworkService);
  private readonly hoverPreview = inject(HoverPreviewService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  protected readonly theme = inject(ThemePrefsService).themeKey;

  protected readonly isWatched = computed(() => this.library.isWatched(this.item().id));

  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly item = input.required<MdbItem>();
  /** Position in the row, rendered as a rank chip. */
  readonly index = input<number | null>(null);

  /*
   * `w342` (342px wide) is sized for the ~230px cards on desktop. On TV the
   * card is now ~113–179px (see `media-row.scss`), so that file is 2–3× more
   * pixels than ever get painted — real bytes over the wire and real decode
   * work for a weak set-top CPU, for detail nobody sees. `w185` matches what
   * the TV card actually needs.
   */
  protected readonly poster = computed(() =>
    upscalePoster(this.item().poster, this.tv.isTv() ? 'w185' : 'w342'),
  );

  /**
   * Real landscape art on Primefly, `null` while unresolved or unavailable
   * — the fallback tile below shows the title rather than ever falling back
   * to a cropped portrait `poster`. Every other theme just shows the poster.
   */
  protected readonly artwork = computed(() => {
    if (this.theme() !== 'primefly' && this.theme() !== 'netflixy') return this.poster();
    return this.landscapeArt.get(this.item().mediatype, this.item().id) ?? null;
  });

  protected readonly link = computed(() => ['/title', toTmdbType(this.item().mediatype), this.item().id]);
  protected readonly label = computed(() =>
    titleWithYear(this.item().title, this.item().release_year),
  );
  protected readonly year = computed(() => formatYear(this.item().release_year));
  protected readonly genres = computed(() => (this.item().genre ?? []).slice(0, 2));
  protected readonly genreLabel = translateGenre;

  protected readonly imdbRating = computed(() => {
    const value = this.item().ratings?.find((r) => r.source === 'imdb')?.value;
    return typeof value === 'number' ? value : null;
  });

  constructor() {
    /*
     * Real landscape art costs a TMDB call per title, so it is only ever
     * requested once this exact card has scrolled into view — the closest
     * web equivalent of Compose's LazyRow only composing what is on screen
     * (native never pays for artwork the viewer never scrolled to either).
     * `rootMargin` starts the fetch a little before the card is actually
     * visible, so the swap from the poster placeholder rarely gets caught
     * mid-scroll.
     */
    effect((onCleanup) => {
      if (this.theme() !== 'primefly' && this.theme() !== 'netflixy') return;

      const item = this.item();
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            this.landscapeArt.request(item.mediatype, item.id);
            observer.disconnect();
          }
        },
        { rootMargin: '200px' },
      );
      observer.observe(this.host.nativeElement);
      onCleanup(() => observer.disconnect());
    });
  }

  /*
   * Prefetch do detalhe: foco (D-pad na TV) e hover armam um timer curto —
   * só quem *para* num card dispara, não a varredura a caminho de outro.
   * Toque dispara na hora: encostar o dedo já é intenção de abrir.
   */
  protected armPrefetch(): void {
    if (this.prefetchTimer !== null) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.prefetchNow();
    }, 200);
  }

  protected cancelPrefetch(): void {
    if (this.prefetchTimer === null) return;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
  }

  protected prefetchNow(): void {
    this.cancelPrefetch();
    this.prefetch.detailFor(this.item().mediatype, this.item().id);
  }

  /**
   * Netflix-style preview — the actual floating card lives in
   * `HoverPreviewCard`, mounted once at the app root; see the doc comment on
   * `HoverPreviewService` for why it can't be rendered from here. This just
   * arms/disarms it. TV focus moves the same way a scan does, so it is
   * excluded outright rather than by timing; `(hover: hover)` catches the
   * touch case a plain `pointerType` check would miss on a hybrid device.
   */
  protected armHoverPreview(): void {
    if (this.tv.isTv() || !matchMedia('(hover: hover)').matches) return;
    this.hoverPreview.arm(this.item(), this.host.nativeElement);
  }

  protected disarmHoverPreview(): void {
    this.hoverPreview.disarm();
  }

  ngOnDestroy(): void {
    this.cancelPrefetch();
  }
}
