import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

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
