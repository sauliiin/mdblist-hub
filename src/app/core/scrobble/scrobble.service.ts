import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { API } from '../api.config';
import { AuthService } from '../auth.service';
import { noCache } from '../http-cache.interceptor';
import { PlaybackSession, ResumeItem, ScrobbleAction, ScrobbleTarget, toResumeItem } from './models';
import { scrobbleBody } from './payload';

/**
 * Playback scrobbling against mdblist.
 *
 * mdblist keeps the session itself: `pause` and `stop` store the point, `start`
 * replaces it, and `/sync/playback` hands the paused ones back — which is what
 * makes a film resumable on another device without this app storing anything.
 * Past 80% mdblist marks the title watched on its own.
 *
 * The API's current schema expects nested JSON. Browser writes use the
 * same-origin proxy in [ApiConfig], because mdblist does not answer the CORS
 * preflight a direct JSON POST would trigger.
 */
@Injectable({ providedIn: 'root' })
export class ScrobbleService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

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
   * not need a cross-origin preflight before the page closes.
   */
  beaconStop(target: ScrobbleTarget, progress: number): void {
    if (!this.auth.key() || (!target.imdbId && !target.tmdbId)) return;

    const url = `${API.mdblist.writeProxy}/scrobble/stop?apikey=${encodeURIComponent(this.auth.key())}`;
    const payload = scrobbleBody(target, progress);

    navigator.sendBeacon?.(
      url,
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    );
  }

  /** Drops a paused session — the "remove from continue watching" action. */
  clear(target: ScrobbleTarget): Observable<boolean> {
    return this.send('clear', target, 0);
  }

  /** Paused sessions, newest progress first, ready for the home row. */
  sessions(): Observable<ResumeItem[]> {
    if (!this.auth.key()) return of([]);

    return this.http
      .get<PlaybackSession[]>(`${API.mdblist.base}/sync/playback`, {
        params: { apikey: this.auth.key() },
        context: noCache(),
      })
      .pipe(
        map((list) =>
          (Array.isArray(list) ? list : [])
            .map(toResumeItem)
            .filter((item): item is ResumeItem => !!item)
            // A title all but finished is not something to offer resuming.
            .filter((item) => item.progress > 1 && item.progress < 95),
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
    if (!this.auth.key() || (!target.imdbId && !target.tmdbId)) return of(false);

    return this.http
      .post(`${API.mdblist.writeProxy}/scrobble/${action}`, scrobbleBody(target, progress), {
        params: { apikey: this.auth.key() },
        context: noCache(),
      })
      .pipe(
        map(() => {
          this.failure.set(null);
          return true;
        }),
        catchError((err: { status?: number; error?: unknown }) => {
          this.failure.set(
            `scrobble/${action} respondeu ${err?.status ?? '?'}: ${describe(err?.error)}`,
          );
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
    return 'sem corpo';
  }
}
