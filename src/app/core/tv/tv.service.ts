import { Injectable, signal } from '@angular/core';

const OVERRIDE_KEY = 'mdblist-hub.tv';

/**
 * Whether this is running on a television.
 *
 * There is no single reliable signal, so three are combined:
 *
 * 1. `tv-build.json` — an asset that exists only in the Gradle `tv` flavor, so
 *    the APK built for Android TV identifies itself outright. This is the
 *    dependable one; the rest are for the browser and for odd devices.
 * 2. `(pointer: none)` — a set-top box has no pointing device at all, unlike a
 *    phone (`coarse`) or a desktop (`fine`).
 * 3. User agent markers that TV WebViews carry.
 *
 * A `localStorage` override wins over all of them, which is what makes the TV
 * layout testable in a desktop browser.
 */
@Injectable({ providedIn: 'root' })
export class TvService {
  private readonly on = signal(detect());

  readonly isTv = this.on.asReadonly();

  constructor() {
    this.apply(this.on());

    // The asset probe is async and only ever turns TV mode *on*, so the
    // synchronous guess above is never downgraded by a slow fetch.
    if (!this.on()) void this.probeBuildFlag();
  }

  /** Forces the mode on or off, or clears the override with `null`. */
  setOverride(value: boolean | null): void {
    if (value === null) localStorage.removeItem(OVERRIDE_KEY);
    else localStorage.setItem(OVERRIDE_KEY, value ? 'on' : 'off');

    const next = detect();
    this.on.set(next);
    this.apply(next);
  }

  private async probeBuildFlag(): Promise<void> {
    try {
      const response = await fetch('tv-build.json', { cache: 'no-store' });
      if (!response.ok) return;

      this.on.set(true);
      this.apply(true);
    } catch {
      // No flag, no TV — the file simply is not in the handset build.
    }
  }

  /** The class every TV stylesheet hangs off. */
  private apply(value: boolean): void {
    document.documentElement.classList.toggle('tv', value);
  }
}

function detect(): boolean {
  const override = localStorage.getItem(OVERRIDE_KEY);
  if (override) return override === 'on';

  if (matchMedia('(pointer: none)').matches) return true;

  const ua = navigator.userAgent;
  return /\b(TV|SmartTV|GoogleTV|AndroidTV|BRAVIA|AFT[A-Z]|Chromecast)\b/i.test(ua);
}
