import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, from, map, of, switchMap } from 'rxjs';
import { GoogleAuthService } from '../google-auth.service';
import { noCache } from '../http-cache.interceptor';

/**
 * Same `safevault-fcbdc` Realtime Database as the other sync services, but a
 * different node: `users/$uid/profile`, the exact path and shape the native
 * apps already read and write (`AuthRepository.kt`) — so linking Google once
 * on any device means never retyping the mdblist key on the others.
 */
const DB = 'https://safevault-fcbdc-default-rtdb.firebaseio.com';

interface Profile {
  mdblistApiKey?: string;
}

@Injectable({ providedIn: 'root' })
export class MdblistKeySyncService {
  private readonly http = inject(HttpClient);
  private readonly googleAuth = inject(GoogleAuthService);

  /** The key stored for the linked Google account, `null` if there is none or nothing is linked. */
  pull(): Observable<string | null> {
    const uid = this.googleAuth.uid();
    if (!uid) return of(null);

    return from(this.googleAuth.idToken()).pipe(
      switchMap((idToken) =>
        this.http.get<Profile | null>(`${DB}/users/${uid}/profile.json`, {
          params: { auth: idToken },
          context: noCache(),
        }),
      ),
      map((profile) => profile?.mdblistApiKey?.trim() || null),
      catchError((error: unknown) => {
        // Silent until now, which made "connected Google but nothing happened"
        // impossible to tell apart from "this account has no key saved".
        console.warn('[mdblist-key-sync] could not read users/%s/profile', uid, error);
        return of(null);
      }),
    );
  }

  /** Saves the key under the linked Google account, so another device can restore it. */
  push(key: string): Observable<void> {
    const uid = this.googleAuth.uid();
    if (!uid) return of(undefined);

    return from(this.googleAuth.idToken()).pipe(
      switchMap((idToken) =>
        this.http.put<unknown>(
          `${DB}/users/${uid}/profile.json`,
          { mdblistApiKey: key } satisfies Profile,
          { params: { auth: idToken }, context: noCache() },
        ),
      ),
      map(() => undefined),
      catchError(() => of(undefined)),
    );
  }
}
