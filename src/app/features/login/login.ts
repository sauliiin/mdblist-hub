import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, of, switchMap } from 'rxjs';
import { AuthService, GUEST_KEY } from '../../core/auth.service';
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
  /** Why the Google-linked restore ended on this form instead of signing in. */
  protected readonly restoreNote = signal<string | null>(null);

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
    if (!key) return;

    this.signIn(key);
  }

  protected loginAsGuest(): void {
    this.signIn(GUEST_KEY);
  }

  private signIn(key: string): void {
    if (this.busy()) return;

    this.busy.set(true);
    this.error.set(null);

    this.auth.signIn(key).subscribe({
      next: () => {
        // The guest key is shared and belongs to no one — syncing it would
        // hand it back on every other device as if it were the user's own.
        if (this.google.linked() && key !== GUEST_KEY) {
          // Bring this browser's widget order, renames and hidden lists in
          // line with whatever is already stored under that account.
          this.listPrefsSync.pull().subscribe({ error: () => undefined });
          // And save the key itself, so the next device that connects this
          // same Google account skips typing it — see `tryAutoRestore`.
          this.mdblistKeySync.push(key).subscribe({ error: () => undefined });
        }

        this.goNext();
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

        if (this.auth.user() && !this.auth.isGuest()) {
          // The mdblist key was already signed in on this browser — pull
          // widget order/renames/hidden lists now too (signing in with the
          // key alone already covers the other order, see `submit` above),
          // and save the key so another device can restore it too.
          this.listPrefsSync.pull().subscribe({ error: () => undefined });
          this.mdblistKeySync.push(this.auth.key()).subscribe({ error: () => undefined });
        } else {
          // Not signed in with a real account here — see if this Google
          // account already has a key stored, so it doesn't have to be typed
          // by hand. A guest session is worth replacing with it.
          //
          // `enterAnyway`: signing into Google is a deliberate "let me in",
          // so it ends inside the app either way. With no key to restore that
          // means the shared catalog, but under the Google name rather than
          // as an anonymous guest — the key can still be pasted later from
          // this same screen.
          this.tryAutoRestore({ enterAnyway: true });
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
  private tryAutoRestore(options: { enterAnyway?: boolean } = {}): void {
    if ((this.auth.user() && !this.auth.isGuest()) || this.autoRestoring()) return;

    this.autoRestoring.set(true);
    this.restoreNote.set(null);

    this.mdblistKeySync
      .pull()
      .pipe(
        switchMap((remoteKey) => {
          if (!remoteKey) {
            this.restoreNote.set(
              this.i18n.t('No mdblist key is saved for this Google account yet — paste yours below and it will be saved for your other devices.'),
            );
            return of(null);
          }

          // Older builds stored the guest key here; signing back in with it
          // would drop the account straight into the read-only session again.
          if (remoteKey === GUEST_KEY) {
            this.restoreNote.set(
              this.i18n.t('The key saved for this Google account is the shared guest one — paste your own below to replace it.'),
            );
            return of(null);
          }

          return this.auth.signIn(remoteKey).pipe(
            catchError(() => {
              this.restoreNote.set(
                this.i18n.t('The key saved for this Google account no longer works — paste a current one below.'),
              );
              return of(null);
            }),
          );
        }),
      )
      .subscribe({
        next: (user) => {
          this.autoRestoring.set(false);

          if (!user) {
            if (!options.enterAnyway) return;
            // Nothing to restore, but the Google click was a "let me in":
            // fall back to the shared catalog, or just go if a session for it
            // is already open.
            if (this.auth.user()) this.goNext();
            else this.signIn(GUEST_KEY);
            return;
          }

          this.listPrefsSync.pull().subscribe({ error: () => undefined });
          this.goNext();
        },
        error: () => this.autoRestoring.set(false),
      });
  }

  /** Back to whatever the guard bounced away from (`next`), or the home page. */
  private goNext(): void {
    const next = this.route.snapshot.queryParamMap.get('next');
    this.router.navigateByUrl(next || '/');
  }

}
