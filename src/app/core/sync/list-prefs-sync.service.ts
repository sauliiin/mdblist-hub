import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, from, map, switchMap, throwError } from 'rxjs';
import { GoogleAuthService } from '../google-auth.service';
import { noCache } from '../http-cache.interceptor';
import { ListPrefsService } from '../list-prefs.service';
import { ListPref } from '../models';

/**
 * Same `safevault-fcbdc` Realtime Database project and `users/$uid` tree as
 * `addon-sync.service.ts` — see that file for why REST over the Firebase SDK,
 * and why writes go through the dev proxy is not a concern here (this is a
 * plain PUT/GET, no CORS preflight-triggering body shape issue).
 */
const DB = 'https://safevault-fcbdc-default-rtdb.firebaseio.com';
const STORAGE_KEY = 'mdblist-hub.list-prefs-sync';
/** Collapses a burst of rename/hide/reorder into a single write. */
const PUSH_DELAY = 1500;

interface Payload {
  updatedAt: string;
  prefs: ListPref[];
}

/** Mirrors `AddonSyncService`'s `SyncRefusal` — see that file for the reasoning. */
class SyncRefusal extends Error {}

@Injectable({ providedIn: 'root' })
export class ListPrefsSyncService {
  private readonly http = inject(HttpClient);
  private readonly listPrefs = inject(ListPrefsService);
  private readonly googleAuth = inject(GoogleAuthService);

  private readonly on = signal<boolean>(localStorage.getItem(STORAGE_KEY) === 'on');
  private readonly last = signal<string | null>(null);
  private readonly failure = signal<string | null>(null);
  private readonly working = signal(false);

  readonly enabled = this.on.asReadonly();
  readonly lastSync = this.last.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly busy = this.working.asReadonly();

  /** Set while a pull is being applied, so it does not echo straight back as a push. */
  private applying = false;
  private pushTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const prefs = this.listPrefs.all();
      if (!this.on() || this.applying || !this.googleAuth.linked()) return;

      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.push(prefs).subscribe(), PUSH_DELAY);
    });
  }

  /** Joins whatever is stored with whatever this browser already had, then pushes both back in sync. */
  enable(): Observable<number> {
    localStorage.setItem(STORAGE_KEY, 'on');
    this.on.set(true);

    return this.request((uid, idToken) =>
      this.read(uid, idToken).pipe(
        switchMap((remote) => {
          const merged = mergePrefs(this.listPrefs.all(), remote);
          this.apply(() => this.listPrefs.replaceAll(merged));
          return this.write(uid, idToken, merged).pipe(map(() => merged.length));
        }),
      ),
    );
  }

  disable(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.on.set(false);
    clearTimeout(this.pushTimer);
    this.failure.set(null);
  }

  /** Makes this browser match what is stored, including removals — see `AddonSyncService.pull()`. */
  pull(): Observable<number> {
    return this.request((uid, idToken) =>
      this.read(uid, idToken).pipe(
        map((remote) => {
          if (!remote.length) {
            throw new SyncRefusal(
              'A nuvem não devolveu nenhuma preferência de lista, então não mexi nas daqui. ' +
                'Use "Enviar" no aparelho que tem as listas certas primeiro.',
            );
          }

          const before = this.listPrefs.all().length;
          this.apply(() => this.listPrefs.replaceAll(remote));
          return Math.abs(remote.length - before);
        }),
      ),
    );
  }

  push(prefs = this.listPrefs.all()): Observable<number> {
    return this.request((uid, idToken) => this.write(uid, idToken, prefs).pipe(map(() => prefs.length)));
  }

  private read(uid: string, idToken: string): Observable<ListPref[]> {
    return this.http
      .get<Payload | null>(`${DB}/users/${uid}/listPrefs.json`, {
        params: { auth: idToken },
        context: noCache(),
      })
      .pipe(map((payload) => payload?.prefs ?? []));
  }

  private write(uid: string, idToken: string, prefs: ListPref[]): Observable<unknown> {
    return this.http.put(
      `${DB}/users/${uid}/listPrefs.json`,
      { updatedAt: new Date().toISOString(), prefs } satisfies Payload,
      { params: { auth: idToken }, context: noCache() },
    );
  }

  private apply<T>(mutate: () => T): T {
    this.applying = true;
    try {
      return mutate();
    } finally {
      this.applying = false;
    }
  }

  private request(
    call: (uid: string, idToken: string) => Observable<number>,
  ): Observable<number> {
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
      map((count) => {
        this.working.set(false);
        this.last.set(new Date().toISOString());
        return count;
      }),
      catchError((cause: unknown) => {
        this.working.set(false);
        const refused = cause instanceof SyncRefusal;
        this.failure.set(
          refused ? cause.message : 'Não foi possível falar com o Firebase. Verifique sua conexão.',
        );
        return throwError(() => (refused ? cause : new Error('sync falhou')));
      }),
    );
  }
}

/** Local wins on a conflicting id — enabling sync should never silently discard an unsynced local edit. */
function mergePrefs(local: ListPref[], remote: ListPref[]): ListPref[] {
  const localIds = new Set(local.map((p) => p.id));
  return [...local, ...remote.filter((p) => !localIds.has(p.id))];
}
