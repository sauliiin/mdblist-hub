import { Injectable, NgZone, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MdbItem } from './models';

/** How long the pointer has to linger before the Netflix-style preview opens. */
const OPEN_DELAY = 3000;
/** Grace window before closing, so crossing from the card into the floating preview doesn't flicker it shut. */
const CLOSE_DELAY = 200;
const PREVIEW_WIDTH = 520;
const PREVIEW_ASPECT = 9 / 16;
/** Kept clear of the viewport edge so the preview never gets clipped by it. */
const VIEWPORT_MARGIN = 10;

export interface HoverPreviewState {
  item: MdbItem;
  left: number;
  top: number;
  width: number;
}

/**
 * Coordinates the Netflix-style hover preview shown by `MediaCard` and
 * rendered by the single `HoverPreviewCard` mounted at the app root.
 *
 * It has to live there, and not as a plain `position: fixed` element inside
 * `MediaCard`'s own template, because `media-row`/`because-you-watched`
 * mark their track `content-visibility: auto` for scroll performance — which
 * unconditionally applies `contain: layout style paint`, and paint
 * containment makes that element the *containing block* for any `position:
 * fixed` descendant (confirmed against the CSS Containment spec, not
 * assumed). A fixed element inside one of those rows is therefore
 * positioned, and clipped, against the row's own small box, not the
 * viewport — which is exactly why an earlier version of this rendered
 * nothing visible. Routing everything through one instance mounted outside
 * any `content-visibility` boundary sidesteps that entirely.
 */
@Injectable({ providedIn: 'root' })
export class HoverPreviewService {
  readonly state = signal<HoverPreviewState | null>(null);

  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly document = inject(DOCUMENT);
  private readonly ngZone = inject(NgZone);

  constructor() {
    this.ngZone.runOutsideAngular(() => {
      this.document.addEventListener('scroll', () => this.forceClose(), { capture: true, passive: true });
    });
  }

  private forceClose(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.cancelClose();
    if (this.state()) {
      this.state.set(null);
    }
  }

  /** A card's own `mouseenter`/`focus`-equivalent — starts the 2s dwell. */
  arm(item: MdbItem, cardEl: HTMLElement): void {
    if (this.state() && this.state()?.item !== item) {
      this.forceClose();
    } else {
      this.cancelClose();
    }

    if (this.state()?.item === item || this.openTimer !== null) return;

    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.state.set({ item, ...position(cardEl) });
    }, OPEN_DELAY);
  }

  /** A card's own `mouseleave` — aborts the dwell, or starts closing an already-open preview. */
  disarm(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (this.state()) this.scheduleClose();
  }

  /** The floating preview's own `mouseenter` — cancels a pending close. */
  keepOpen(): void {
    this.cancelClose();
  }

  /** The floating preview's own `mouseleave` — the pointer left it for good. */
  close(): void {
    this.scheduleClose();
  }

  private scheduleClose(): void {
    if (this.closeTimer !== null) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.state.set(null);
    }, CLOSE_DELAY);
  }

  private cancelClose(): void {
    if (this.closeTimer === null) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }
}

/** Centres the floating preview over the small card, clamped inside the viewport. */
function position(cardEl: HTMLElement): { left: number; top: number; width: number } {
  const rect = cardEl.getBoundingClientRect();
  const width = Math.min(PREVIEW_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const height = width * PREVIEW_ASPECT;

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2 - 60;

  const left = clamp(centerX - width / 2, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const top = clamp(centerY - height / 2, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

  return { left, top, width };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
