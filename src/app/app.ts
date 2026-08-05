import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { PlatformService } from './core/platform.service';
import { SpatialNavigation } from './core/tv/spatial-navigation';
import { TvService } from './core/tv/tv.service';
import { BottomNav } from './ui/bottom-nav/bottom-nav';

@Component({
  selector: 'app-root',
  imports: [BottomNav, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly platform = inject(PlatformService);
  protected readonly tv = inject(TvService);

  constructor() {
    // Harmless off a television: the handler returns immediately unless the
    // TV flag is set, so the one listener costs nothing on a phone.
    inject(SpatialNavigation).start();
  }

  /** Drives the frosted background that fades in once the page scrolls. */
  protected readonly scrolled = signal(false);

  protected readonly user = this.auth.user;
  /** Points at the signed-in account's own page on mdblist.com. */
  protected readonly listsUrl = this.auth.listsUrl;
  /** Set when the avatar 404s, so the initial takes over. */
  protected readonly avatarBroken = signal(false);

  @HostListener('window:scroll')
  protected onScroll(): void {
    this.scrolled.set(window.scrollY > 24);
  }

  protected signOut(): void {
    this.auth.signOut();
    this.router.navigate(['/login']);
  }
}
