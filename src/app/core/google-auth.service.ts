import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, firstValueFrom, from, throwError } from 'rxjs';
import { noCache } from './http-cache.interceptor';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
/** Web OAuth client already registered on the `safevault-fcbdc` Firebase project — see google-services.json. */
const CLIENT_ID = '862741916290-5bhenqt1prf98341g2douaedchkqv3nb.apps.googleusercontent.com';
const API_KEY = 'AIzaSyCJ4LJ7EjqZgp3hif6kp5kjBA5g0oacef4';
const STORAGE_KEY = 'mdblist-hub.google';
/** Refreshed a little before the token is actually due to expire, not at the deadline. */
const REFRESH_SLACK_MS = 60_000;

export interface GoogleProfile {
  email: string;
  displayName: string;
  photoUrl: string;
}

interface GoogleSession extends GoogleProfile {
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface IdpSignInResponse {
  localId: string;
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  email: string;
  displayName?: string;
  photoUrl?: string;
}

interface RefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
}

/** The slice of Google Identity Services this uses — an ID token, nothing else. */
interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        callback: (response: { credential: string }) => void;
      }): void;
      prompt(): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

/**
 * Ties a Google identity to this browser, purely so `PreferencesSyncService`
 * and the addon list have an `auth.uid` to sync under — the same one the
 * Android and TV apps already sign in with. Entirely separate from
 * `AuthService`'s mdblist key: neither login signs the other out, and nothing
 * here touches catalog data.
 *
 * Kept to plain REST, the same way `addon-sync.service.ts` reaches the
 * Realtime Database: this only ever needs an ID token and its refresh, both a
 * couple of fetches away, so pulling in the full Firebase Auth SDK would only
 * add weight for a call shape `HttpClient` already covers.
 */
@Injectable({ providedIn: 'root' })
export class GoogleAuthService {
  private readonly http = inject(HttpClient);

  private readonly account = signal<GoogleSession | null>(stored());

  readonly linked = computed(() => !!this.account());
  readonly profile = computed<GoogleProfile | null>(() => {
    const session = this.account();
    return session ? { email: session.email, displayName: session.displayName, photoUrl: session.photoUrl } : null;
  });

  /** The Firebase `uid` every synced path is keyed on — see `database.rules.json`. */
  readonly uid = computed(() => this.account()?.uid ?? null);

  private gisReady: Promise<void> | null = null;

  /** Loads the Google prompt on demand and exchanges the chosen account for a Firebase session. */
  signIn(): Observable<GoogleProfile> {
    return from(this.runSignIn()).pipe(
      catchError((error: unknown) => throwError(() => asError(error))),
    );
  }

  signOut(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.account.set(null);
  }

  /**
   * The token any Realtime Database write authenticates with, refreshed
   * first when it is close to expiring. Every sync service calls this
   * immediately before a request rather than reading `idToken` directly, so
   * a session that has been sitting idle for an hour still works.
   */
  async idToken(): Promise<string> {
    const session = this.account();
    if (!session) throw new Error('Nenhuma conta Google conectada.');
    if (Date.now() < session.expiresAt - REFRESH_SLACK_MS) return session.idToken;

    const response = await firstValueFrom(
      this.http.post<RefreshResponse>(
        `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, context: noCache() },
      ),
    );

    const next: GoogleSession = {
      ...session,
      idToken: response.id_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + Number(response.expires_in) * 1000,
    };
    this.persist(next);
    return next.idToken;
  }

  private async runSignIn(): Promise<GoogleProfile> {
    await this.loadGis();
    const credential = await this.promptGis();
    const session = await this.exchange(credential);
    this.persist(session);
    return { email: session.email, displayName: session.displayName, photoUrl: session.photoUrl };
  }

  /** Injects the GIS script once, memoised — never fetched just because the app booted. */
  private loadGis(): Promise<void> {
    this.gisReady ??= new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Não foi possível carregar o Google Identity Services.'));
      document.head.appendChild(script);
    });
    return this.gisReady;
  }

  /** Wraps GIS's callback-shaped `accounts.id` flow in a promise for one ID token. */
  private promptGis(): Promise<string> {
    return new Promise((resolve, reject) => {
      const identity = window.google?.accounts.id;
      if (!identity) {
        reject(new Error('Google Identity Services indisponível.'));
        return;
      }

      identity.initialize({
        client_id: CLIENT_ID,
        callback: (response) => resolve(response.credential),
      });
      identity.prompt();
    });
  }

  /** Trades the Google ID token for a Firebase identity on the `safevault-fcbdc` project. */
  private async exchange(googleIdToken: string): Promise<GoogleSession> {
    const response = await firstValueFrom(
      this.http.post<IdpSignInResponse>(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${API_KEY}`,
        {
          postBody: `id_token=${googleIdToken}&providerId=google.com`,
          requestUri: location.origin,
          returnSecureToken: true,
        },
        { context: noCache() },
      ),
    );

    return {
      uid: response.localId,
      idToken: response.idToken,
      refreshToken: response.refreshToken,
      expiresAt: Date.now() + Number(response.expiresIn) * 1000,
      email: response.email,
      displayName: response.displayName || response.email,
      photoUrl: response.photoUrl || '',
    };
  }

  private persist(session: GoogleSession): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    this.account.set(session);
  }
}

function stored(): GoogleSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GoogleSession) : null;
  } catch {
    return null;
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Não foi possível conectar com o Google.');
}
