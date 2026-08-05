import { Injectable, inject } from '@angular/core';
import { TvService } from './tv.service';

type Direction = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const KEYS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * D-pad navigation for the TV build.
 *
 * A remote has four directions and OK, and the DOM order that serves Tab is
 * rarely the order things sit on screen — pressing right inside a row of
 * posters has to reach the next poster, not whatever comes next in the
 * markup. So movement is resolved geometrically: of everything focusable in
 * the pressed direction, take whichever is closest, with drift off the axis
 * penalised so a glance sideways does not win over the obvious neighbour.
 *
 * Anything that handles its own arrows opts out with `data-spatial="off"` —
 * the video player does, since there arrows are seek and volume.
 */
@Injectable({ providedIn: 'root' })
export class SpatialNavigation {
  private readonly tv = inject(TvService);
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    // Capture phase, so this runs before component-level handlers and can
    // decide whether to let the key through.
    document.addEventListener('keydown', (event) => this.onKey(event), true);
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.tv.isTv() || event.altKey || event.ctrlKey || event.metaKey) return;

    const direction = KEYS[event.key];
    if (!direction) return;

    const active = document.activeElement as HTMLElement | null;

    // Text fields and selects need their own arrow behaviour.
    if (active && isTextEntry(active)) return;
    if (active?.closest('[data-spatial="off"]')) return;

    const next = this.override(active, direction) ?? this.find(active, direction);
    if (!next) return;

    event.preventDefault();
    event.stopPropagation();

    next.focus({ preventScroll: true });
    this.reveal(next);
  }

  /**
   * Brings the newly focused element into view.
   *
   * Reaching the hero is the one case that is not "scroll this into view": the
   * hero *is* the top of the page, and stopping at whichever button was focused
   * would leave the featured title half cut off above it. So focus landing
   * anywhere in the hero scrolls the page home instead.
   */
  private reveal(element: HTMLElement): void {
    if (element.closest('app-hero')) {
      scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    element.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  /**
   * An explicit destination, from `data-nav-down` and friends holding a CSS
   * selector.
   *
   * Geometry gets the common cases right but cannot know intent: below the
   * hero buttons sits the search bar, so "down" would land there when what is
   * actually wanted is the first row of titles. An override says so outright.
   * If the selector matches nothing on screen — a row that has not deferred in
   * yet, say — the geometric search still runs.
   */
  private override(from: HTMLElement | null, direction: Direction): HTMLElement | null {
    const selector = from?.dataset[`nav${direction[0].toUpperCase()}${direction.slice(1)}`];
    if (!selector) return null;

    return [...document.querySelectorAll<HTMLElement>(selector)].find(visible) ?? null;
  }

  private find(from: HTMLElement | null, direction: Direction): HTMLElement | null {
    const candidates = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(visible)
      .filter((element) => !skipped(element, from));
    if (!candidates.length) return null;

    // Nothing focused yet — the first press should land somewhere sensible.
    if (!from || from === document.body) return candidates[0] ?? null;

    const origin = from.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      if (candidate === from) continue;

      const rect = candidate.getBoundingClientRect();
      const score = this.score(origin, rect, direction);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best;
  }

  /**
   * Distance along the direction of travel, plus a heavy penalty for drifting
   * off it. The weight is what keeps "right" inside a row of posters instead of
   * jumping to whatever sits diagonally below.
   */
  private score(origin: DOMRect, target: DOMRect, direction: Direction): number {
    const horizontal = direction === 'left' || direction === 'right';

    // Gap along the axis of travel — negative means the target is behind us.
    const advance = horizontal
      ? direction === 'right'
        ? target.left - origin.right
        : origin.left - target.right
      : direction === 'down'
        ? target.top - origin.bottom
        : origin.top - target.bottom;

    // A sliver of tolerance, so neighbours that merely touch still count.
    if (advance < -2) return Infinity;

    const originMid = horizontal ? origin.top + origin.height / 2 : origin.left + origin.width / 2;
    const targetMid = horizontal ? target.top + target.height / 2 : target.left + target.width / 2;
    const drift = Math.abs(originMid - targetMid);

    // Overlapping on the cross axis is the strongest hint of "same row" or
    // "same column"; anything that does gets a large discount.
    const overlaps = horizontal
      ? target.bottom > origin.top && target.top < origin.bottom
      : target.right > origin.left && target.left < origin.right;

    return Math.max(advance, 0) + drift * (overlaps ? 0.3 : 3);
  }
}

/**
 * Whether a candidate is inside a region the D-pad passes over.
 *
 * The home page's filter bar sits between the hero and the rows, so without
 * this, "up" from the first title lands in the search box instead of returning
 * to the featured title. Anything already inside such a region still navigates
 * within it normally — the skip only applies to entering from outside.
 */
function skipped(element: HTMLElement, from: HTMLElement | null): boolean {
  const region = element.closest('[data-nav-skip]');
  return !!region && !from?.closest('[data-nav-skip]');
}

function isTextEntry(element: HTMLElement): boolean {
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return element.isContentEditable;

  // Checkboxes and buttons in input clothing do not consume arrows.
  const type = (element as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
}

function visible(element: HTMLElement): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}
