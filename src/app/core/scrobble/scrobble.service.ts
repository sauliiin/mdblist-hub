import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { API } from '../api.config';
import { AuthService } from '../auth.service';
import { noCache } from '../http-cache.interceptor';
import { PlaybackSession, ResumeItem, ScrobbleAction, ScrobbleTarget, toResumeItem } from './models';

/**
 * Playback scrobbling against mdblist.
 *
 * mdblist keeps the session itself: `pause` and `stop` store the point, `start`
 * replaces it, and `/sync/playback` hands the paused ones back — which is what
 * makes a film resumable on another device without this app storing anything.
 * Past 80% mdblist marks the title watched on its own.
 *
 * The bodies go out **form-encoded, never JSON**, and that is load-bearing: a
 * JSON POST needs a CORS preflight, and mdblist answers OPTIONS with 405 (the
 * same wall the library writes hit — see README). `application/x-www-form-
 * urlencoded` is a CORS-safelisted type, so the request is "simple" and goes
 * straight out. That is why scrobbling works from a static host and adding to
 * a watchlist does not.
 */
@Injectable({ providedIn: 'root' })
export class ScrobbleService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  /**
   * The raw body of the last rejection, surfaced in the player.
   *
   * mdblist checks the API key before it validates the body, so the exact
   * spelling of the nested target fields could not be confirmed against the
   * live API beforehand. If the encoding below is wrong, the answer says so
   * and lands here rather than disappearing.
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
   * page is going away, and it can only issue simple requests — which the
   * form-encoded body already is, so nothing has to change to use it.
   */
  beaconStop(target: ScrobbleTarget, progress: number): void {
    if (!this.auth.key() || (!target.imdbId && !target.tmdbId)) return;

    const url = `${API.mdblist.base}/scrobble/stop?apikey=${encodeURIComponent(this.auth.key())}`;
    const form = new URLSearchParams(body(target, progress).toString());

    navigator.sendBeacon?.(
      url,
      new Blob([form.toString()], { type: 'application/x-www-form-urlencoded' }),
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
      .post(`${API.mdblist.base}/scrobble/${action}`, body(target, progress), {
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

/**
 * Builds the form body.
 *
 * The nested target is written in bracket notation (`movie[ids][imdb]`), which
 * is how the common server frameworks read nested form data. mdblist's schema
 * also accepts a flat `season`/`episode` pair for shows, so that is the shape
 * used here rather than the nested alternative.
 */
function body(target: ScrobbleTarget, progress: number): HttpParams {
  const root = target.type === 'show' ? 'show' : 'movie';
  let params = new HttpParams().set('progress', progress.toFixed(2));

  if (target.imdbId) params = params.set(`${root}[ids][imdb]`, target.imdbId);
  if (target.tmdbId) params = params.set(`${root}[ids][tmdb]`, String(target.tmdbId));

  if (root === 'show' && target.season && target.episode) {
    params = params
      .set('show[season]', String(target.season))
      .set('show[episode]', String(target.episode));
  }

  return params;
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
