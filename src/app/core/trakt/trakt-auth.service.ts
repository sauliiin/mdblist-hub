import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, concat, concatMap, map, of, shareReplay, switchMap, takeWhile, tap, timer } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { API } from '../api.config';
import { noCache } from '../http-cache.interceptor';
import { TraktAccount, TraktDeviceCode, TraktLinkState, TraktSession } from './models';

const SESSION_KEY = 'mdblist-hub.trakt.session';
const ACCOUNT_KEY = 'mdblist-hub.trakt.account';

/** See `API.trakt` — the packaged app has no proxy in front of it. */
const AUTH_BASE = Capacitor.isNativePlatform() ? API.trakt.auth : API.trakt.authProxy;
const API_BASE = Capacitor.isNativePlatform() ? API.trakt.api : API.trakt.apiProxy;

/** Refresh this long before the token actually expires. */
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * The Trakt account link.
 *
 * Only the device flow is implemented, the same one the native apps use: no
 * redirect URI to register and nothing to hand control to and get back from.
 * The user reads a code here and approves it at trakt.tv/activate on whatever
 * device already has a browser open — including this one.
 *
 * The token pair lives in `localStorage` next to the mdblist key, and is
 * renewed here rather than by each caller: `TraktService` asks for a valid
 * token before every request and replays once after a 401.
 */
@Injectable({ providedIn: 'root' })
export class TraktAuthService {
  private readonly http = inject(HttpClient);

  private readonly session = signal<TraktSession | null>(storedSession());
  private readonly profile = signal<TraktAccount | null>(storedAccount());

  /** In-flight renewal, so two parallel 401s spend one refresh token. */
  private renewal$: Observable<TraktSession | null> | null = null;

  readonly linked = computed(() => !!this.session());
  readonly account = this.profile.asReadonly();

  /**
   * Runs a whole link attempt: asks Trakt for a code, emits it for the panel
   * to show, and keeps polling until the user approves, denies, or the code
   * expires. Every emission is the state to render — nothing to interpret.
   */
  link(): Observable<TraktLinkState> {
    const request$ = this.http
      .post<DeviceCodeDto>(
        `${AUTH_BASE}/oauth/device/code`,
        { client_id: API.trakt.clientId },
        { headers: this.baseHeaders(), context: noCache() },
      )
      .pipe(
        map(
          (dto): TraktDeviceCode => ({
            userCode: dto.user_code,
            verificationUrl: dto.verification_url || API.trakt.activateUrl,
            deviceCode: dto.device_code,
            intervalSeconds: Math.max(dto.interval || 5, 5),
            expiresInSeconds: dto.expires_in || 600,
          }),
        ),
        switchMap((code) => this.poll(code)),
        catchError(() => of<TraktLinkState>({ kind: 'failed', reason: 'unavailable' })),
      );

    return concat(of<TraktLinkState>({ kind: 'requesting' }), request$);
  }

  /**
   * Tells Trakt to forget the token, then forgets it here regardless — a
   * revoke that fails must not leave the browser holding a credential the
   * user asked to be rid of.
   */
  unlink(): void {
    const session = this.session();
    this.clear();
    if (!session) return;

    this.http
      .post(
        `${AUTH_BASE}/oauth/revoke`,
        {
          token: session.accessToken,
          client_id: API.trakt.clientId,
          client_secret: API.trakt.clientSecret,
        },
        { headers: this.baseHeaders(), context: noCache() },
      )
      .pipe(catchError(() => of(null)))
      .subscribe();
  }

  /**
   * A usable access token, renewing first when the stored one is spent.
   * Resolves to null when no account is linked or the link is gone for good.
   */
  token(): Observable<string | null> {
    const session = this.session();
    if (!session) return of(null);
    if (session.expiresAt - RENEW_MARGIN_MS > Date.now()) return of(session.accessToken);

    return this.renew().pipe(map((renewed) => renewed?.accessToken ?? null));
  }

  /** Forces a renewal — what `TraktService` calls after Trakt answers 401. */
  renew(): Observable<TraktSession | null> {
    const session = this.session();
    if (!session?.refreshToken) {
      this.clear();
      return of(null);
    }

    this.renewal$ ??= this.http
      .post<TokenDto>(
        `${AUTH_BASE}/oauth/token`,
        {
          refresh_token: session.refreshToken,
          client_id: API.trakt.clientId,
          client_secret: API.trakt.clientSecret,
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          grant_type: 'refresh_token',
        },
        { headers: this.baseHeaders(), context: noCache() },
      )
      .pipe(
        map((dto) => this.store(dto)),
        catchError(() => {
          // The refresh token is single use and this one is spent: there is
          // nothing left to try, and pretending otherwise would keep every
          // Trakt row failing silently until the user noticed.
          this.clear();
          return of(null);
        }),
        tap(() => (this.renewal$ = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );

    return this.renewal$;
  }

  /** `trakt-api-key` and the version, which even the OAuth calls require. */
  baseHeaders(): HttpHeaders {
    return new HttpHeaders({
      'trakt-api-key': API.trakt.clientId,
      'trakt-api-version': API.trakt.version,
      'Content-Type': 'application/json',
    });
  }

  authHeaders(token: string): HttpHeaders {
    return this.baseHeaders().set('Authorization', `Bearer ${token}`);
  }

  /** Who the stored token belongs to — the handle shown next to "Disconnect". */
  fetchAccount(token: string): Observable<TraktAccount | null> {
    return this.http
      .get<{ user?: { username?: string; name?: string } }>(`${API_BASE}/users/settings`, {
        headers: this.authHeaders(token),
        context: noCache(),
      })
      .pipe(
        map((dto) => (dto.user?.username ? { username: dto.user.username, name: dto.user.name } : null)),
        tap((account) => {
          this.profile.set(account);
          if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
        }),
        catchError(() => of(null)),
      );
  }

  /**
   * The polling half of the device flow.
   *
   * One tick a second drives the countdown the panel prints; only every
   * `interval` seconds does a tick also ask Trakt whether the code was
   * approved. `concatMap` rather than `switchMap` so the next tick cannot
   * cancel an exchange already in flight.
   */
  private poll(code: TraktDeviceCode): Observable<TraktLinkState> {
    const deadline = Date.now() + code.expiresInSeconds * 1000;

    return timer(0, 1000).pipe(
      concatMap((tick): Observable<TraktLinkState> => {
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        if (remaining <= 0) return of<TraktLinkState>({ kind: 'failed', reason: 'expired' });

        const waiting: TraktLinkState = { kind: 'awaiting', code, secondsRemaining: remaining };
        if (tick === 0 || tick % code.intervalSeconds !== 0) return of(waiting);

        return this.exchange(code.deviceCode, waiting);
      }),
      takeWhile((state) => state.kind === 'awaiting', true),
    );
  }

  /** One `oauth/device/token` attempt, read entirely from the status code. */
  private exchange(deviceCode: string, waiting: TraktLinkState): Observable<TraktLinkState> {
    return this.http
      .post<TokenDto>(
        `${AUTH_BASE}/oauth/device/token`,
        {
          code: deviceCode,
          client_id: API.trakt.clientId,
          client_secret: API.trakt.clientSecret,
        },
        { headers: this.baseHeaders(), context: noCache() },
      )
      .pipe(
        switchMap((dto) => {
          const session = this.store(dto);
          return this.fetchAccount(session.accessToken).pipe(
            map((account): TraktLinkState => ({ kind: 'linked', account })),
          );
        }),
        catchError((error: HttpErrorResponse) => {
          switch (error.status) {
            // 400 is "not yet approved" and 429 is "you are asking too often";
            // both mean keep waiting rather than give up.
            case 400:
            case 429:
              return of(waiting);
            case 410:
              return of<TraktLinkState>({ kind: 'failed', reason: 'expired' });
            case 418:
              return of<TraktLinkState>({ kind: 'failed', reason: 'denied' });
            default:
              return of<TraktLinkState>({ kind: 'failed', reason: 'unavailable' });
          }
        }),
      );
  }

  private store(dto: TokenDto): TraktSession {
    const session: TraktSession = {
      accessToken: dto.access_token,
      refreshToken: dto.refresh_token,
      // `created_at` is in seconds and may be missing; "now" is close enough
      // either way, since the margin above is a full day.
      expiresAt: ((dto.created_at ?? Date.now() / 1000) + (dto.expires_in ?? 0)) * 1000,
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    this.session.set(session);
    return session;
  }

  private clear(): void {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
    this.session.set(null);
    this.profile.set(null);
    this.renewal$ = null;
  }
}

interface DeviceCodeDto {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface TokenDto {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  created_at?: number;
}

function storedSession(): TraktSession | null {
  return read<TraktSession>(SESSION_KEY, (value) => !!value.accessToken && !!value.refreshToken);
}

function storedAccount(): TraktAccount | null {
  return read<TraktAccount>(ACCOUNT_KEY, (value) => !!value.username);
}

function read<T>(key: string, valid: (value: T) => boolean): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
