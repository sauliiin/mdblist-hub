import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'mdblist-hub.dim-unwatched-episodes';

/**
 * Whether an unwatched episode's still image is dimmed and blurred, so the
 * ones already seen stand apart from the ones that are not at a glance —
 * requested after the default styling (a slight fade on *watched* stills,
 * see `episode-row.scss`) turned out to be too subtle for that on a season
 * grid full of near-identical stills.
 *
 * Local only, unlike `ThemePrefsService` and `SubtitlePrefsService`: this is
 * a display preference for a single page, not something a viewer would
 * expect to follow them to another device.
 */
@Injectable({ providedIn: 'root' })
export class EpisodeDisplayPrefsService {
  private readonly dim = signal<boolean>(localStorage.getItem(STORAGE_KEY) === 'on');

  readonly dimUnwatched = this.dim.asReadonly();

  setDimUnwatched(value: boolean): void {
    localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
    this.dim.set(value);
  }

  toggleDimUnwatched(): void {
    this.setDimUnwatched(!this.dim());
  }
}
