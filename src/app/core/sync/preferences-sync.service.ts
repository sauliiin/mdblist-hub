import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, from, map, switchMap, throwError } from 'rxjs';
import { GoogleAuthService } from '../google-auth.service';
import { noCache } from '../http-cache.interceptor';
import { SubtitlePrefsService } from '../subtitle-prefs.service';

/**
 * Same Realtime Database as `addon-sync.service.ts`, but the `safevault-fcbdc`
 * project the native apps actually use, under the `users/$uid` tree their
 * `database.rules.json` already grants — see that file for the `preferences`
 * node's schema.
 */
const DB = 'https://safevault-fcbdc-default-rtdb.firebaseio.com';
/** Collapses a burst of preference changes into a single write. */
const PUSH_DELAY = 1500;

interface Payload {
  updatedAt: string;
  subtitleFont: string;
}

@Injectable({ providedIn: 'root' })
export class PreferencesSyncService {
  private readonly http = inject(HttpClient);
  private readonly googleAuth = inject(GoogleAuthService);
  private readonly subtitlePrefs = inject(SubtitlePrefsService);

  private readonly failure = signal<string | null>(null);
  private readonly working = signal(false);

  readonly error = this.failure.asReadonly();
  readonly busy = this.working.asReadonly();

  /** Set while a pull is being applied, so it does not echo straight back as a push. */
  private applying = false;
  private pushTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Any local preference change becomes a write, once an account is linked
    // — debounced so flipping through fonts is one request, not several.
    effect(() => {
      const font = this.subtitlePrefs.fontKey();
      if (!this.googleAuth.linked() || this.applying) return;

      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.push(font).subscribe(), PUSH_DELAY);
    });
  }

  /** Pulls whatever is stored and applies it locally — used right after linking a Google account. */
  pull(): Observable<void> {
    return this.request((uid, idToken) =>
      this.read(uid, idToken).pipe(
        map((payload) => {
          if (payload?.subtitleFont) {
            this.applying = true;
            try {
              this.subtitlePrefs.setFont(payload.subtitleFont);
            } finally {
              this.applying = false;
            }
          }
        }),
      ),
    );
  }

  push(subtitleFont = this.subtitlePrefs.fontKey()): Observable<void> {
    return this.request((uid, idToken) => this.write(uid, idToken, subtitleFont));
  }

  private read(uid: string, idToken: string): Observable<Payload | null> {
    return this.http.get<Payload | null>(`${DB}/users/${uid}/preferences.json`, {
      params: { auth: idToken },
      context: noCache(),
    });
  }

  private write(uid: string, idToken: string, subtitleFont: string): Observable<void> {
    return this.http
      .put<unknown>(
        `${DB}/users/${uid}/preferences.json`,
        { updatedAt: new Date().toISOString(), subtitleFont } satisfies Payload,
        { params: { auth: idToken }, context: noCache() },
      )
      .pipe(map(() => undefined));
  }

  private request(call: (uid: string, idToken: string) => Observable<void>): Observable<void> {
    const uid = this.googleAuth.uid();
    if (!uid) {
      const message = 'Conecte sua conta Google primeiro.';
      this.failure.set(message);
      return throwError(() => new Error(message));
    }

    this.working.set(true);
    this.failure.set(null);

    return from(this.googleAuth.idToken()).pipe(
      switchMap((idToken) => call(uid, idToken)),
      map((result) => {
        this.working.set(false);
        return result;
      }),
      catchError((cause: unknown) => {
        this.working.set(false);
        this.failure.set('Não foi possível falar com o Firebase. Verifique sua conexão.');
        return throwError(() => cause);
      }),
    );
  }
}
