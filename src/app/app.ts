import {
  ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { PlatformService } from './core/platform.service';
import { THEME_OPTIONS, ThemePrefsService } from './core/theme-prefs.service';
import { SpatialNavigation } from './core/tv/spatial-navigation';
import { TvService } from './core/tv/tv.service';
import { BottomNav } from './ui/bottom-nav/bottom-nav';
import { HoverPreviewCard } from './ui/hover-preview-card/hover-preview-card';

const THEME_CLASSES = THEME_OPTIONS.map((option) => `${option.key}-theme`).filter(
  (cls) => cls !== 'normal-theme',
);

@Component({
  selector: 'app-root',
  imports: [BottomNav, HoverPreviewCard, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly platform = inject(PlatformService);
  protected readonly tv = inject(TvService);
  private readonly themePrefs = inject(ThemePrefsService);

  constructor() {
    // Harmless off a television: the handler returns immediately unless the
    // TV flag is set, so the one listener costs nothing on a phone.
    inject(SpatialNavigation).start();

    // Runs once on creation as well as on every later change, which is what
    // lets this replace the old constructor-only `classList.toggle` call —
    // that one only ever painted the *initial* value; picking a theme after
    // boot had nothing re-applying the class. `themeKey` is already
    // persisted (see `ThemePrefsService`), so the class here is always in
    // step with what a reload will paint next time too.
    effect(() => {
      const value = this.themePrefs.themeKey();
      document.body.classList.remove(...THEME_CLASSES);
      if (value !== 'normal') document.body.classList.add(`${value}-theme`);
    });
  }

  /** Drives the frosted background that fades in once the page scrolls. */
  protected readonly scrolled = signal(false);

  protected readonly user = this.auth.user;
  /** Points at the signed-in account's own page on mdblist.com. */
  protected readonly listsUrl = this.auth.listsUrl;
  /** Set when the avatar 404s, so the initial takes over. */
  protected readonly avatarBroken = signal(false);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly theme = this.themePrefs.themeKey;
  protected readonly themeMenuOpen = signal(false);
  /** The active option's own label — same convention as a native `<select>`. */
  protected readonly activeThemeLabel = computed(
    () => this.themeOptions.find((option) => option.key === this.theme())?.label ?? 'Aparência',
  );

  @HostListener('window:scroll')
  protected onScroll(): void {
    this.scrolled.set(window.scrollY > 24);
  }

  protected signOut(): void {
    this.auth.signOut();
    this.router.navigate(['/login']);
  }

  protected pickTheme(key: string): void {
    this.themePrefs.setTheme(key);
    this.themeMenuOpen.set(false);
  }

  protected toggleThemeMenu(): void {
    this.themeMenuOpen.update((v) => !v);
  }
}
