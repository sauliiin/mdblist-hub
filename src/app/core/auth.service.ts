import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { API } from './api.config';
import { GoogleAuthService } from './google-auth.service';
import { clearHttpCache } from './http-cache.interceptor';
import { MdbUser } from './models';

const STORAGE_KEY = 'mdblist-hub.apikey';

/**
 * Shared read-only key behind "Continue as Guest". Belongs to a dedicated
 * guest account (gejud) with its own free quota — entirely separate from
 * the owner's personal key — so visitor traffic never touches the owner's
 * 100 k/day limit.
 *
 * The guest account intentionally has no lists of its own; the home page
 * falls back to `GUEST_LIST_IDS` below so visitors always see curated
 * content rather than an empty screen.
 */
export const GUEST_KEY = 'mt2bio7iy6u2f0sfb640f52eu';

/**
 * Public list IDs from the owner's curated account (mestreyodarossi).
 * Used as a fallback when the signed-in key is the guest one — the guest
 * account has no lists, so without this the home page would be empty.
 * Each ID here corresponds to a non-private list accessible by any
 * authenticated key via the normal `/lists/{id}/items` endpoint.
 */
export const GUEST_LIST_IDS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 179686, name: "Can't go wrong movies" },
  { id: 92577,  name: 'Best ever' },
  { id: 198687, name: 'Trending Shows' },
  { id: 166395, name: 'Trending movies' },
  { id: 101251, name: 'Lastest movie releases' },
  { id: 99442,  name: 'A\u00e7\u00e3o e Aventura' },
  { id: 101250, name: "Series can't go wrong" },
  { id: 100439, name: 'Fantasia' },
  { id: 137061, name: 'Animation' },
  { id: 142498, name: 'Surprise me' },
  { id: 167124, name: 'Horror' },
  { id: 167210, name: 'Suspense' },
  { id: 167637, name: 'Science fiction' },
  { id: 104379, name: 'Combina com Voc\u00ea' },
  { id: 120667, name: 'Supernatural' },
  { id: 123815, name: 'Best of super heroe' },
  { id: 94403,  name: 'Zombies and Outbreak' },
  { id: 99441,  name: 'New suspense' },
  { id: 167209, name: 'Good old thriller and suspense movies' },
  { id: 167633, name: 'Good old Sci Fi' },
  { id: 167634, name: 'Average new Sci Fi movies' },
  { id: 167117, name: 'Good old horror movies' },
  { id: 167121, name: 'Newest average horror movies' },
  { id: 192140, name: 'Recommended for Jedi' },
  { id: 191663, name: 'Surprise me again' },
  { id: 165119, name: 'Last Watched' },
];

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
  private readonly google = inject(GoogleAuthService);

  private readonly apikey = signal<string>(stored());
  private readonly account = signal<MdbUser | null>(null);

  /** The `apikey` every mdblist request carries; empty when signed out. */
  readonly key = this.apikey.asReadonly();
  readonly user = this.account.asReadonly();

  /** True if the session is running on the shared visitor key. */
  readonly isGuest = computed(() => this.apikey() === GUEST_KEY);

  /**
   * Whether playback is offered. Streams come from the installed addons, not
   * from mdblist, so signing in with Google is identity enough — what the
   * shared key must not do is *write*, which is `canSaveToLibrary` below.
   */
  readonly canPlay = computed(() => !this.isGuest() || this.google.linked());

  /**
   * Whether watchlist/collection/watched can be saved — a key of one's own
   * and nothing else. The shared key would file every visitor's titles into
   * the same project account, where all the others would then read them back
   * as their own library.
   */
  readonly canSaveToLibrary = computed(() => !!this.apikey() && !this.isGuest());

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
      }),
    );
  }

  /**
   * Restores a stored session on boot, resolving to `false` when there is none
   * or the key no longer works. The route guard waits on this, which is what
   * lets everything downstream read the signed-in account synchronously.
   *
   * Only a 401/403 from mdblist means the key itself is bad — everything
   * else (no connectivity yet, a timeout, mdblist briefly down) is the app
   * catching a bad moment, not a bad key. The two used to be treated the
   * same, which meant coming back from the background right as the network
   * interface was still reconnecting could wipe a perfectly good key from
   * `localStorage` via `signOut()` — the user was then stuck re-typing it,
   * and the retry attempt could itself race the same still-settling network
   * and wipe it again. `profile$` is deliberately not cached here so the
   * next `restore()` (next navigation, next resume) gets a fresh attempt
   * instead of replaying this one's failure.
   */
  restore(): Observable<boolean> {
    if (this.account()) return of(true);
    if (!this.apikey()) return of(false);

    return this.fetchProfile(this.apikey()).pipe(
      tap((user) => this.account.set(user)),
      map(() => true),
      catchError((err: HttpErrorResponse) => {
        if (err.status === 401 || err.status === 403) {
          this.signOut();
        }
        return of(false);
      }),
    );
  }

  signOut(): void {
    clearHttpCache();
    localStorage.removeItem(STORAGE_KEY);
    this.apikey.set('');
    this.account.set(null);
  }

  private fetchProfile(key: string): Observable<MdbUser> {
    return this.http.get<MdbUser>(`${API.mdblist.base}/user`, { params: { apikey: key } });
  }
}

function stored(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}
