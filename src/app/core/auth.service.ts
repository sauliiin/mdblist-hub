import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, shareReplay, tap } from 'rxjs';
import { API, OWNER_USERNAME } from './api.config';
import { clearHttpCache } from './http-cache.interceptor';
import { MdbUser } from './models';

const STORAGE_KEY = 'mdblist-hub.apikey';

/**
 * Holds the visitor's mdblist API key and the account behind it.
 *
 * The key is typed on the login screen and kept in `localStorage` — nothing is
 * baked into the bundle, so the published site works for anyone with an mdblist
 * account and never carries write access to someone else's.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly apikey = signal<string>(stored());
  private readonly account = signal<MdbUser | null>(null);
  /** In-flight (then settled) `/user` call, so a boot only asks once. */
  private profile$: Observable<MdbUser | null> | null = null;

  /** The `apikey` every mdblist request carries; empty when signed out. */
  readonly key = this.apikey.asReadonly();
  readonly user = this.account.asReadonly();

  /** Only the owner gets the curated home — see `OWNER_USERNAME`. */
  readonly isOwner = computed(
    () => (this.account()?.username ?? '').toLowerCase() === OWNER_USERNAME,
  );

  /** The signed-in account's public list page on mdblist.com. */
  readonly listsUrl = computed(() => {
    const username = this.account()?.username;
    return username ? `https://mdblist.com/lists/${username}` : 'https://mdblist.com/lists';
  });

  /** Checks the key against `/user` and, if it answers, keeps the session. */
  signIn(key: string): Observable<MdbUser> {
    const trimmed = key.trim();

    return this.fetchProfile(trimmed).pipe(
      tap((user) => {
        // A previous session's responses are cached under its own key, but
        // dropping them keeps a re-login from reading stale lists.
        clearHttpCache();
        localStorage.setItem(STORAGE_KEY, trimmed);
        this.apikey.set(trimmed);
        this.account.set(user);
        this.profile$ = of(user);
      }),
    );
  }

  /**
   * Restores a stored session on boot, resolving to `false` when there is none
   * or the key no longer works. The route guard waits on this, which is what
   * lets everything downstream read `isOwner()` synchronously.
   */
  restore(): Observable<boolean> {
    if (this.account()) return of(true);
    if (!this.apikey()) return of(false);

    this.profile$ ??= this.fetchProfile(this.apikey()).pipe(
      catchError(() => of(null)),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    return this.profile$.pipe(
      tap((user) => (user ? this.account.set(user) : this.signOut())),
      map((user) => !!user),
    );
  }

  signOut(): void {
    clearHttpCache();
    localStorage.removeItem(STORAGE_KEY);
    this.apikey.set('');
    this.account.set(null);
    this.profile$ = null;
  }

  private fetchProfile(key: string): Observable<MdbUser> {
    return this.http.get<MdbUser>(`${API.mdblist.base}/user`, { params: { apikey: key } });
  }
}

function stored(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}
