import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of, switchMap } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { GoogleAuthService } from '../../core/google-auth.service';
import { I18nPipe, I18nService } from '../../core/i18n.service';
import { ListPrefsSyncService } from '../../core/sync/list-prefs-sync.service';
import { MdblistKeySyncService } from '../../core/sync/mdblist-key-sync.service';
import { PreferencesSyncService } from '../../core/sync/preferences-sync.service';
import { AliasPrefsService } from '../../core/alias-prefs.service';

@Component({
  selector: 'app-login',
  imports: [I18nPipe],
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
  private readonly listPrefsSync = inject(ListPrefsSyncService);
  private readonly mdblistKeySync = inject(MdblistKeySyncService);
  private readonly i18n = inject(I18nService);

  protected readonly key = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Toggles the key between dots and plain text. */
  protected readonly revealed = signal(false);
  /** True while trying the Google-linked key before asking for one by hand — see `tryAutoRestore`. */
  protected readonly autoRestoring = signal(false);

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

  // -------------------------------------------------------- Alias
  private readonly aliasPrefs = inject(AliasPrefsService);
  protected readonly alias = this.aliasPrefs.alias;
  protected editingAlias = signal(false);

  protected onAliasUpdate(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.aliasPrefs.setAlias(value);
  }

  constructor() {
    // A returning visitor whose Google session outlived their mdblist one
    // lands here with `googleLinked()` already true — the same restore
    // `connectGoogle()` triggers on a fresh click, just without the click.
    if (this.google.linked()) this.tryAutoRestore();
  }

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
        if (this.google.linked()) {
          // Bring this browser's widget order, renames and hidden lists in
          // line with whatever is already stored under that account.
          this.listPrefsSync.pull().subscribe({ error: () => undefined });
          // And save the key itself, so the next device that connects this
          // same Google account skips typing it — see `tryAutoRestore`.
          this.mdblistKeySync.push(key).subscribe({ error: () => undefined });
        }

        // `next` carries the page the guard bounced away from, if any.
        const next = this.route.snapshot.queryParamMap.get('next');
        this.router.navigateByUrl(next || '/');
      },
      error: (err: { status?: number }) => {
        this.busy.set(false);
        this.error.set(
          err?.status === 0
            ? this.i18n.t('Could not reach mdblist. Check your connection.')
            : this.i18n.t('Invalid key. Make sure you copied the entire key from your mdblist preferences.'),
        );
      },
    });
  }

  protected loginAsGuest(): void {
    if (this.busy()) return;
    this.key.set('omqfcrbt1dm8hj98mwuvgpg9n');
    // Using an arbitrary fake event to satisfy the signature if needed,
    // or just call the logic. But submit expects an event.
    // Instead we can just duplicate the submit logic slightly or mock the event.
    const fakeEvent = new Event('submit');
    this.submit(fakeEvent);
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

        if (this.auth.user()) {
          // The mdblist key was already signed in on this browser — pull
          // widget order/renames/hidden lists now too (signing in with the
          // key alone already covers the other order, see `submit` above),
          // and save the key so another device can restore it too.
          this.listPrefsSync.pull().subscribe({ error: () => undefined });
          this.mdblistKeySync.push(this.auth.key()).subscribe({ error: () => undefined });
        } else {
          // Not signed in yet here — see if this Google account already has
          // a key stored, so it doesn't have to be typed by hand.
          this.tryAutoRestore();
        }
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

  /**
   * Mirrors the native apps' own restore path (`AuthRepository.kt`): once
   * Google is linked, whatever mdblist key is stored under `users/$uid/profile`
   * is tried before ever asking for one by hand. A miss (nothing stored yet,
   * or the stored key no longer validates) just leaves the form as it was —
   * this never surfaces an error of its own.
   */
  private tryAutoRestore(): void {
    if (this.auth.user() || this.autoRestoring()) return;

    this.autoRestoring.set(true);
    this.mdblistKeySync
      .pull()
      .pipe(switchMap((remoteKey) => (remoteKey ? this.auth.signIn(remoteKey) : of(null))))
      .subscribe({
        next: (user) => {
          this.autoRestoring.set(false);
          if (!user) return;

          this.listPrefsSync.pull().subscribe({ error: () => undefined });
          const next = this.route.snapshot.queryParamMap.get('next');
          this.router.navigateByUrl(next || '/');
        },
        error: () => this.autoRestoring.set(false),
      });
  }
}
