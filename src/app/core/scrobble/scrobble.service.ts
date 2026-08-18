import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { API } from '../api.config';
import { AuthService } from '../auth.service';
import { noCache } from '../http-cache.interceptor';
import { translate } from '../i18n.service';
import { LibraryProviderService } from '../library-provider.service';
import { TraktService } from '../trakt/trakt.service';
import { PlaybackSession, ResumeItem, ScrobbleAction, ScrobbleTarget, toResumeItem } from './models';
import { scrobbleBody } from './payload';

/**
 * Playback scrobbling, against mdblist or Trakt — whichever
 * `LibraryProviderService` says owns the account's library.
 *
 * mdblist keeps the session itself: `pause` and `stop` store the point, `start`
 * replaces it, and `/sync/playback` hands the paused ones back — which is what
 * makes a film resumable on another device without this app storing anything.
 * Past 80% mdblist marks the title watched on its own.
 *
 * The API's current schema expects nested JSON. Browser writes use the
 * same-origin proxy in [ApiConfig], because mdblist does not answer the CORS
 * preflight a direct JSON POST would trigger — same reasoning as
 * `library.service.ts`'s `WRITE_BASE`, and the same fix: the packaged app has
 * no dev-server proxy behind `/mdblist-api` to answer that path, so it writes
 * straight to mdblist instead.
 */
const WRITE_BASE = Capacitor.isNativePlatform() ? API.mdblist.base : API.mdblist.writeProxy;

@Injectable({ providedIn: 'root' })
export class ScrobbleService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly trakt = inject(TraktService);
  private readonly provider = inject(LibraryProviderService);

  /**
   * The raw body of the last rejection, surfaced in the player rather than
   * disappearing as a generic playback warning.
   */
  private readonly failure = signal<string | null>(null);
  readonly error = this.failure.asReadonly();

  start(target: ScrobbleTarget, progress: number): Observable<boolean> {
    return this.send('start', target, progress);
  }

  pause(target: ScrobbleTarget, progress: number): Observable<boolean> {
    return this.send('pause', target, progress);
  }

  stop(target: ScrobbleTarget, progress: number): Observable<boolean> {
    return this.send('stop', target, progress);
  }

  /**
   * A stop that survives the tab closing.
   *
   * `sendBeacon` is the only request the browser commits to delivering once the
   * page is going away. It targets the same-origin proxy, so its JSON Blob does
   * not need a cross-origin preflight before the page closes. Trakt needs a
   * bearer token a beacon cannot carry, so that path uses a keepalive `fetch`
   * instead — see `TraktService.beaconStop`.
   */
  beaconStop(target: ScrobbleTarget, progress: number): void {
    if (this.provider.usingTrakt()) {
      this.trakt.beaconStop(target, progress);
      return;
    }

    if (!this.auth.canSaveToLibrary() || (!target.imdbId && !target.tmdbId)) return;

    const url = `${WRITE_BASE}/scrobble/stop?apikey=${encodeURIComponent(this.auth.key())}`;
    const payload = scrobbleBody(target, progress);

    navigator.sendBeacon?.(
      url,
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    );
  }

  /**
   * Drops a paused session — the "remove from continue watching" action.
   *
   * [playbackId] is only meaningful on Trakt, which deletes a session by its
   * own id; mdblist addresses the title and ignores it. It rides on the resume
   * row (`ResumeItem.playbackId`), which is where a caller finds it.
   */
  clear(target: ScrobbleTarget, playbackId?: number | null): Observable<boolean> {
    if (this.provider.usingTrakt()) return this.trakt.clear(playbackId);
    return this.send('clear', target, 0);
  }

  /** Paused sessions, ready for the home row, from whichever provider owns them. */
  sessions(): Observable<ResumeItem[]> {
    const source$ = this.provider.usingTrakt() ? this.trakt.sessions() : this.mdblistSessions();

    // A title all but finished is not something to offer resuming, wherever
    // the session came from.
    return source$.pipe(
      map((items) => items.filter((item) => item.progress > 1 && item.progress < 95)),
    );
  }

  private mdblistSessions(): Observable<ResumeItem[]> {
    // Same reason `send` refuses to write: what the shared account has half
    // watched is not this visitor's continue-watching row.
    if (!this.auth.canSaveToLibrary()) return of([]);

    return this.http
      .get<PlaybackSession[]>(`${API.mdblist.base}/sync/playback`, {
        params: { apikey: this.auth.key() },
        context: noCache(),
      })
      .pipe(
        map((list) =>
          (Array.isArray(list) ? list : [])
            .map(toResumeItem)
            .filter((item): item is ResumeItem => !!item),
        ),
        catchError(() => of([])),
      );
  }

  /** The stored point for one title, or null when there is none. */
  resumeFor(target: ScrobbleTarget): Observable<number | null> {
    return this.sessions().pipe(
      map((items) => items.find((item) => matches(item, target))?.progress ?? null),
    );
  }

  private send(
    action: ScrobbleAction,
    target: ScrobbleTarget,
    progress: number,
  ): Observable<boolean> {
    if (!target.imdbId && !target.tmdbId) return of(false);

    if (this.provider.usingTrakt()) {
      return this.trakt.scrobble(action, target, progress).pipe(
        map((sent) => {
          this.failure.set(null);
          return sent;
        }),
        catchError((err: { status?: number; error?: unknown }) => {
          this.failure.set(translate('scrobble/{action} returned {status}: {detail}', {
            action,
            status: err?.status ?? '?',
            detail: describe(err?.error),
          }));
          return of(false);
        }),
      );
    }

    // The shared key can play but must not write: its account is the same one
    // every other anonymous visitor is watching under.
    if (!this.auth.canSaveToLibrary()) return of(false);

    return this.http
      .post(`${WRITE_BASE}/scrobble/${action}`, scrobbleBody(target, progress), {
        params: { apikey: this.auth.key() },
        context: noCache(),
      })
      .pipe(
        map(() => {
          this.failure.set(null);
          return true;
        }),
        catchError((err: { status?: number; error?: unknown }) => {
          this.failure.set(translate('scrobble/{action} returned {status}: {detail}', {
            action,
            status: err?.status ?? '?',
            detail: describe(err?.error),
          }));
          return of(false);
        }),
      );
  }
}

function matches(item: ResumeItem, target: ScrobbleTarget): boolean {
  const sameTitle = target.imdbId
    ? item.imdbId === target.imdbId
    : item.tmdbId === target.tmdbId;
  if (!sameTitle) return false;

  if (target.type !== 'show') return true;
  return item.season === (target.season ?? null) && item.episode === (target.episode ?? null);
}

function describe(payload: unknown): string {
  if (typeof payload === 'string') return payload.slice(0, 200);
  try {
    return JSON.stringify(payload).slice(0, 200);
  } catch {
    return translate('no response body');
  }
}
