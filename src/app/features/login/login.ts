import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { GoogleAuthService } from '../../core/google-auth.service';
import { PreferencesSyncService } from '../../core/sync/preferences-sync.service';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly google = inject(GoogleAuthService);
  private readonly preferencesSync = inject(PreferencesSyncService);

  protected readonly key = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Toggles the key between dots and plain text. */
  protected readonly revealed = signal(false);

  // -------------------------------------------------------- Google account
  /**
   * Purely for cross-device sync (addons, player preferences) — see
   * `PreferencesSyncService` and the addons page. Entirely separate from the
   * mdblist key above: linking or unlinking this never signs the mdblist
   * session out, and vice versa.
   */
  protected readonly googleLinked = this.google.linked;
  protected readonly googleProfile = this.google.profile;
  protected readonly googleBusy = signal(false);
  protected readonly googleError = signal<string | null>(null);

  protected onKey(event: Event): void {
    this.key.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const key = this.key().trim();
    if (!key || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);

    this.auth.signIn(key).subscribe({
      next: () => {
        // `next` carries the page the guard bounced away from, if any.
        const next = this.route.snapshot.queryParamMap.get('next');
        this.router.navigateByUrl(next || '/');
      },
      error: (err: { status?: number }) => {
        this.busy.set(false);
        this.error.set(
          err?.status === 0
            ? 'Não foi possível falar com o mdblist. Verifique sua conexão.'
            : 'Chave inválida. Confira se copiou a chave inteira das preferências do mdblist.',
        );
      },
    });
  }

  // -------------------------------------------------------- Google account

  protected connectGoogle(): void {
    if (this.googleBusy()) return;

    this.googleBusy.set(true);
    this.googleError.set(null);

    this.google.signIn().subscribe({
      next: () => {
        this.googleBusy.set(false);
        // Best-effort: brings this browser's font choice in line with
        // whatever was last synced, without blocking the button on it.
        this.preferencesSync.pull().subscribe({ error: () => undefined });
      },
      error: (err: Error) => {
        this.googleBusy.set(false);
        this.googleError.set(err.message);
      },
    });
  }

  protected disconnectGoogle(): void {
    this.google.signOut();
  }
}
