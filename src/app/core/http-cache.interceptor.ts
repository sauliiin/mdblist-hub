import {
  HttpContext, HttpContextToken, HttpEvent, HttpInterceptorFn, HttpResponse,
} from '@angular/common/http';
import { Observable, from, of, shareReplay, switchMap, tap } from 'rxjs';
import {
  DISK_MAX_AGE_MS, clearStored, readStored, writeStored,
} from './http-disk-cache';

interface CacheEntry {
  expires: number;
  response: HttpResponse<unknown>;
}

/**
 * Opts a request out of the cache below. Stream lists from Stremio addons go
 * through this: a debrid link is minted per request and expires, so serving a
 * ten-minute-old one would hand the player a dead URL.
 */
export const NO_CACHE = new HttpContextToken<boolean>(() => false);

/** Convenience for `{ context: noCache() }` on a request. */
export function noCache(): HttpContext {
  return new HttpContext().set(NO_CACHE, true);
}

/** Within this age a response is served with no network at all. */
const FRESH_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
/** In-flight requests, so two rows asking for the same URL only hit the wire once. */
const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

/** Drops everything cached, memory and disk — used when the signed-in account changes. */
export function clearHttpCache(): void {
  cache.clear();
  inFlight.clear();
  void clearStored();
}

/**
 * Three-layer read path — memory, disk, network — with stale-while-revalidate
 * in the middle:
 *
 * 1. Memory (10 min): same-session hits, e.g. navigating back to the home.
 * 2. IndexedDB (up to 7 days): a cold start paints instantly from the last
 *    session's responses. A copy older than 10 min is still served, but a
 *    background refetch updates both layers, so the *next* read is current.
 * 3. Network: cache misses; the response lands in both layers on the way out.
 *
 * Concurrent identical requests share one wire call at every layer.
 */
export const httpCacheInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET' || req.context.get(NO_CACHE)) return next(req);

  const key = req.urlWithParams;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return of(hit.response.clone());
  }
  cache.delete(key);

  /** Starts (or joins) the network fetch for this URL. */
  const fetchFromNetwork = (): Observable<HttpEvent<unknown>> => {
    const pending = inFlight.get(key);
    if (pending) return pending;

    const request$ = next(req).pipe(
      tap({
        next: (event) => {
          if (event instanceof HttpResponse) {
            cache.set(key, { expires: Date.now() + FRESH_TTL_MS, response: event.clone() });
            void writeStored({ url: key, body: event.body, status: event.status, storedAt: Date.now() });
            inFlight.delete(key);
          }
        },
        error: () => inFlight.delete(key),
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    inFlight.set(key, request$);
    return request$;
  };

  return from(readStored(key)).pipe(
    switchMap((stored) => {
      const age = stored ? Date.now() - stored.storedAt : Infinity;
      if (!stored || age >= DISK_MAX_AGE_MS) return fetchFromNetwork();

      const response = new HttpResponse({ body: stored.body, status: stored.status, url: req.url });
      if (age < FRESH_TTL_MS) {
        cache.set(key, { expires: stored.storedAt + FRESH_TTL_MS, response: response.clone() });
      } else {
        // Stale: serve it anyway (instant paint), refresh behind the scenes.
        fetchFromNetwork().subscribe({ error: () => {} });
      }
      return of(response);
    }),
  );
};
