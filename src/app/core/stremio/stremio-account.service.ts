import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, switchMap, tap, throwError } from 'rxjs';
import { noCache } from '../http-cache.interceptor';
import { AddonsService } from './addons.service';
import { ImportReport, StremioManifest } from './models';

const API = 'https://api.strem.io/api';
const STORAGE_KEY = 'mdblist-hub.stremio';

/**
 * Every call answers HTTP 200 and reports failure in the body, so the status
 * code tells us nothing — `unwrap()` below is what actually decides.
 */
interface ApiResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface LoginResult {
  authKey: string;
  user?: { email?: string };
}

interface CollectionResult {
  addons?: { transportUrl?: string; manifest?: StremioManifest }[];
}

/** The stored session — the key the API hands back, never the password. */
interface Session {
  authKey: string;
  email: string;
}

/**
 * Signing in to a Stremio account to pull its addon collection.
 *
 * Addons otherwise live in `localStorage`, which is per browser and per origin
 * — so the same person on a phone, or on the published site rather than the dev
 * server, starts empty. Stremio already keeps the collection server-side, and
 * `api.strem.io` answers `Access-Control-Allow-Origin: *`, so the browser can
 * read it directly and the app stays backend-free.
 *
 * The password is posted straight to `api.strem.io` and never stored; what is
 * kept is the `authKey` it returns.
 */
@Injectable({ providedIn: 'root' })
export class StremioAccountService {
  private readonly http = inject(HttpClient);
  private readonly addons = inject(AddonsService);

  private readonly session = signal<Session | null>(stored());

  readonly account = this.session.asReadonly();

  /** Signs in and immediately imports the collection. */
  login(email: string, password: string): Observable<ImportReport> {
    return this.post<LoginResult>('login', {
      type: 'Login',
      email: email.trim(),
      password,
    }).pipe(
      tap((result) => {
        if (!result.authKey) throw new Error('A API do Stremio não devolveu uma sessão.');
        this.persist({ authKey: result.authKey, email: result.user?.email ?? email.trim() });
      }),
      switchMap(() => this.sync()),
    );
  }

  /** Re-reads the collection for the session already stored. */
  sync(): Observable<ImportReport> {
    const session = this.session();
    if (!session) return throwError(() => new Error('Entre na sua conta Stremio primeiro.'));

    return this.post<CollectionResult>('addonCollectionGet', {
      type: 'AddonCollectionGet',
      authKey: session.authKey,
      // What the official client sends. Without it the API can answer from a
      // stored snapshot, so an addon added in Stremio minutes ago never shows
      // up here — which is exactly the failure this flag was tried against.
      update: true,
    }).pipe(
      map((result) => this.addons.importCollection(result.addons ?? [])),
      catchError((err: Error) => {
        // The only error worth special handling: an expired or revoked key.
        if (/session/i.test(err.message)) {
          this.forget();
          return throwError(
            () => new Error('Sua sessão do Stremio expirou. Entre novamente.'),
          );
        }
        return throwError(() => err);
      }),
    );
  }

  /** Drops the session here. The addons already imported stay put. */
  logout(): Observable<void> {
    const session = this.session();
    this.forget();
    if (!session) return of(undefined);

    return this.post<unknown>('logout', { type: 'Logout', authKey: session.authKey }).pipe(
      map(() => undefined),
      // Nothing here depends on the server agreeing; the key is already gone.
      catchError(() => of(undefined)),
    );
  }

  private post<T>(path: string, body: unknown): Observable<T> {
    return this.http
      .post<ApiResponse<T>>(`${API}/${path}`, body, { context: noCache() })
      .pipe(
        catchError(() =>
          throwError(() => new Error('Não foi possível falar com a API do Stremio.')),
        ),
        map((response) => {
          if (response?.error) throw new Error(translate(response.error.message));
          if (!response?.result) throw new Error('Resposta inesperada da API do Stremio.');
          return response.result;
        }),
      );
  }

  private persist(session: Session): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    this.session.set(session);
  }

  private forget(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.session.set(null);
  }
}

/** The API's messages are English and terse; these are the ones users hit. */
function translate(message: string): string {
  const known: Record<string, string> = {
    'Wrong passphrase': 'Senha incorreta.',
    'User not found': 'Não existe conta Stremio com esse e-mail.',
    'Session does not exist': 'Sessão do Stremio expirada. Entre novamente.',
  };
  return known[message] ?? message;
}

function stored(): Session | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return raw?.authKey ? raw : null;
  } catch {
    return null;
  }
}
