import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Where the app is running, and how big the window is.
 *
 * The Android build and a phone-sized browser want the same layout — bottom
 * tabs, no hover affordances, bigger touch targets — so the flag that drives
 * the CSS is "handset", not "native". `native` stays separate for the few
 * things that really are container-specific, like the status bar inset.
 */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  /** Running inside the Capacitor shell rather than a browser tab. */
  readonly native = Capacitor.isNativePlatform();

  private readonly narrow = signal(matchMedia('(max-width: 860px)').matches);
  private readonly landscape = signal(matchMedia('(orientation: landscape)').matches);

  /** Phone-shaped, whether that is the APK or a small browser window. */
  readonly handset = this.narrow.asReadonly();
  readonly isLandscape = this.landscape.asReadonly();

  constructor() {
    matchMedia('(max-width: 860px)').addEventListener('change', (e) => this.narrow.set(e.matches));
    matchMedia('(orientation: landscape)').addEventListener('change', (e) =>
      this.landscape.set(e.matches),
    );

    // A class on the root beats threading a signal through every stylesheet:
    // the touch rules below are pure CSS and never need to be read back.
    if (this.native) document.documentElement.classList.add('native');
  }
}
