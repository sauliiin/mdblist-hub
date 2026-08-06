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

/** Every value a remote's OK/select button has been seen reporting as. */
const SELECT_KEYS = new Set(['Enter', ' ', 'Spacebar']);

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

  /** Where focus last landed, so it can be recovered if that element vanishes. */
  private lastRect: DOMRect | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;

    // Capture phase, so this runs before component-level handlers and can
    // decide whether to let the key through.
    document.addEventListener('keydown', (event) => this.onKey(event), true);

    /*
     * A row that starts loading because focus landed on its placeholder (see
     * `home.html`) replaces that placeholder with real content once the fetch
     * resolves — and the DOM node that had focus is gone. Losing focus on a TV
     * is not a cosmetic problem: without a mouse there is no other way to move
     * it again, so the remote would simply stop doing anything.
     *
     * `childList`/`subtree` catches exactly this swap. The callback is cheap
     * in the overwhelmingly common case (focus is still somewhere valid, one
     * property read and return) and only searches the page when it is not.
     */
    new MutationObserver(() => this.recoverFocus()).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private recoverFocus(): void {
    if (!this.tv.isTv() || !this.lastRect) return;

    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;

    const candidates = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
    if (!candidates.length) return;

    let best: HTMLElement | null = null;
    let bestDistance = Infinity;

    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left - this.lastRect.left;
      const dy = rect.top - this.lastRect.top;
      const distance = dx * dx + dy * dy;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }

    if (best) {
      best.focus({ preventScroll: true });
      this.reveal(best);
      this.lastRect = best.getBoundingClientRect();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.tv.isTv() || event.altKey || event.ctrlKey || event.metaKey) return;

    const active = document.activeElement as HTMLElement | null;

    // Text fields and selects need their own arrow behaviour.
    if (active && isTextEntry(active)) return;

    /*
     * A region that handles its own keys owns *all* of them, OK included —
     * not just the arrows. This check used to sit below the OK handling, so
     * pressing OK inside the video player was intercepted here and turned
     * into a click on the player's own wrapper `<div>`, which has no click
     * handler: the press did nothing at all, and the player never got the
     * chance to reveal its controls.
     */
    if (active?.closest('[data-spatial="off"]')) return;

    if (SELECT_KEYS.has(event.key)) {
      this.select(event);
      return;
    }

    const direction = KEYS[event.key];
    if (!direction) return;

    const next = this.override(active, direction) ?? this.find(active, direction);
    if (!next) return;

    event.preventDefault();
    event.stopPropagation();

    next.focus({ preventScroll: true });
    this.lastRect = next.getBoundingClientRect();
    this.reveal(next);
  }

  /**
   * Activates whatever is focused, instead of trusting the browser to
   * synthesize a click from Enter/Space on its own.
   *
   * That synthesis is old, standard behaviour for a focused button or link —
   * but this app's real audience is whatever budget Android TV box someone
   * happens to own, and how faithfully a given one's WebView implements that
   * step is not something to bet the entire "press OK" gesture on. Taking
   * over here only requires the box to deliver the key event at all, which
   * the arrow-key navigation already proves it does. `preventDefault` on the
   * keydown suppresses the browser's own synthesis before it can fire, so
   * this replaces it rather than doubling it.
   */
  private select(event: KeyboardEvent): void {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || isTextEntry(active)) return;

    event.preventDefault();
    active.click();
  }

  /** The `[data-row]` currently pinned to `ROW_TOP`, so a re-entry into the same row is a no-op. */
  private activeRow: Element | null = null;

  /**
   * Brings the newly focused element into view.
   *
   * Reaching the hero is the one case that is not "scroll this into view": the
   * hero *is* the top of the page, and stopping at whichever button was focused
   * would leave the featured title half cut off above it. So focus landing
   * anywhere in the hero scrolls the page home instead.
   *
   * Moving into a *different* `[data-row]` is the other special case: rather
   * than scrolling just enough to reveal whichever card was picked (which
   * would leave every row sitting wherever it naturally falls in the page),
   * the row's own heading is pinned to the same fixed point every time. Since
   * the poster strip sits a fixed distance below its heading in every row's
   * own CSS, pinning the heading is all it takes to pin the posters too — a
   * list swaps in at the same spot the previous one just occupied, rather
   * than the page scrolling further down with each row.
   */
  private reveal(element: HTMLElement): void {
    if (element.closest('app-hero')) {
      scrollTo({ top: 0, behavior: 'smooth' });
      this.activeRow = null;
      return;
    }

    const row = element.closest('[data-row]');
    if (row && row !== this.activeRow) {
      this.activeRow = row;
      this.pinRow(row);
      // Deliberately no `return`: pinning only handles the *vertical* placement
      // of the row. The card still has to be brought to the fixed horizontal
      // slot below, or entering a row left its strip wherever it happened to
      // be scrolled and the focus appeared to jump sideways.
    }

    /*
     * Android WebView may treat `scrollIntoView({ inline: 'start' })` as a
     * no-op while the next card is already visible. That lets focus walk over
     * the whole first viewport and only starts scrolling at the first card of
     * the "second page". Move the strip to an absolute item offset instead:
     * every item then occupies the exact slot where the row's first item began.
     */
    if (row) {
      this.pinItemToRowStart(row, element);
      return;
    }

    // Controls outside a media row still use the browser's normal reveal.
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  /** Keeps a row's focused item in the screen position of its first item. */
  private pinItemToRowStart(row: Element, element: HTMLElement): void {
    const track = element.closest<HTMLElement>('.track');
    if (!track || track.closest('[data-row]') !== row) return;

    let item = element;
    while (item.parentElement && item.parentElement !== track) item = item.parentElement;

    const first = track.firstElementChild;
    if (item.parentElement !== track || !(first instanceof HTMLElement)) return;

    /*
     * The two flex items share an offset parent, so their difference is stable
     * even during a smooth scroll and ignores the focused card's CSS scale.
     * It is also independent of viewport width, card size and row padding.
     */
    const left = Math.max(0, item.offsetLeft - first.offsetLeft);
    track.scrollTo({ left, top: track.scrollTop, behavior: 'smooth' });
  }

  /**
   * Scrolls so `row` lands at a fixed distance from the top.
   *
   * This used to compute an absolute target by hand (`rect.top + scrollY -
   * offset`) and call `scrollTo`. That math reads `window.scrollY` at the
   * instant of the keypress — fine for one press, but a remote's D-pad
   * auto-repeats while held, and each repeat landed mid-flight of the
   * previous smooth scroll, recomputing a target from a baseline that was
   * itself still animating. The visible result was exactly the continuous
   * "dragging a scrollbar" feel this was supposed to replace, instead of
   * discrete rows snapping into place.
   *
   * `scrollIntoView` has no such problem: retriggering it mid-animation just
   * redirects the same smooth scroll to the new target, which is what makes
   * holding the button down feel like stepping through rows rather than
   * sliding. `scroll-margin-top: 28px` on `[data-row]` (styles.scss) is what
   * supplies the fixed offset now, so `block: 'start'` lands exactly at
   * `ROW_TOP` without this method needing to know the number itself.
   */
  private pinRow(row: Element): void {
    (row as HTMLElement).scrollIntoView({ block: 'start', behavior: 'smooth' });
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

  /**
   * Picks the nearest focusable element in `direction`.
   *
   * Every candidate is measured exactly once, in a single pass. The earlier
   * shape — `.filter(visible)` and then `getBoundingClientRect()` again inside
   * the scoring loop — measured each one twice, and `getBoundingClientRect`
   * and `getComputedStyle` both force the browser to flush pending layout.
   * With a dozen loaded rows that is a few hundred forced reflows per keypress,
   * which is precisely the budget a weak set-top box does not have. The
   * candidate's rect now travels with it from the visibility check into the
   * score.
   */
  private find(from: HTMLElement | null, direction: Direction): HTMLElement | null {
    const candidates: { element: HTMLElement; rect: DOMRect }[] = [];

    for (const element of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (skipped(element, from)) continue;

      const rect = measureVisible(element);
      if (rect) candidates.push({ element, rect });
    }

    if (!candidates.length) return null;

    // Nothing focused yet — the first press should land somewhere sensible.
    if (!from || from === document.body) return candidates[0]?.element ?? null;

    const origin = from.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Infinity;

    for (const { element, rect } of candidates) {
      if (element === from) continue;

      const score = this.score(origin, rect, direction);
      if (score < bestScore) {
        bestScore = score;
        best = element;
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

    /*
     * Left/right is a filmstrip gesture: it moves along one row and nothing
     * else. Without this, running out of cards to the right — nothing left
     * to satisfy `advance` — let the search fall through to the *nearest*
     * candidate anywhere on the page that was merely further right, drift
     * penalty or not: another row, the topbar, the search field. That is
     * what read as "wraps to the first item" — it did not wrap, it jumped to
     * an unrelated row that happened to start near the same x position. Up
     * and down are exactly the move meant to leave the row, so only the
     * horizontal case is locked to the strip.
     */
    if (horizontal && !overlaps) return Infinity;

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

/**
 * The element's box if it is a usable D-pad target, `null` otherwise.
 *
 * Returns the rect rather than a boolean so the caller can reuse the
 * measurement it already paid for — see `find()`. The cheap attribute and
 * selector checks come first so most rejects never reach a layout flush.
 */
function measureVisible(element: HTMLElement): DOMRect | null {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
    return null;
  }

  /*
   * The row scroll chevrons (`ui/media-row`'s `.nav.prev`/`.nav.next`) are a
   * mouse affordance that happens to be real `<button>` elements, always
   * present in the DOM. Card-to-card D-pad movement already does what they do
   * — nudge the row along — one card at a time, so leaving them reachable
   * only gave "right" at the row's edge somewhere odd to land: a button whose
   * own geometry does not sit among the cards it controls.
   */
  if (element.matches('.nav.prev, .nav.next')) return null;

  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const style = getComputedStyle(element);
  const shown =
    style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';

  return shown ? rect : null;
}

/** Boolean form, for the callers that only need the verdict. */
function visible(element: HTMLElement): boolean {
  return measureVisible(element) !== null;
}
