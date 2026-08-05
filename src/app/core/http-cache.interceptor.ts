import { HttpEvent, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Observable, of, shareReplay, tap } from 'rxjs';

interface CacheEntry {
  expires: number;
  response: HttpResponse<unknown>;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
/** In-flight requests, so two rows asking for the same URL only hit the wire once. */
const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

/** Drops everything cached — used when the signed-in account changes. */
export function clearHttpCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Caches GET responses in memory for 10 minutes and de-duplicates concurrent
 * identical requests. Navigating back to the home page is then instant instead
 * of re-fetching 25 lists.
 */
export const httpCacheInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET') return next(req);

  const key = req.urlWithParams;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return of(hit.response.clone());
  }
  cache.delete(key);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request$ = next(req).pipe(
    tap({
      next: (event) => {
        if (event instanceof HttpResponse) {
          cache.set(key, { expires: Date.now() + TTL_MS, response: event.clone() });
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
