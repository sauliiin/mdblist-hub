import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, from, map, of, switchMap, throwError } from 'rxjs';
import { GoogleAuthService } from '../google-auth.service';
import { noCache } from '../http-cache.interceptor';
import { translate } from '../i18n.service';
import { AddonsService } from '../stremio/addons.service';
import { InstalledAddon } from '../stremio/models';

/**
 * Realtime Database, reached over its REST interface rather than the Firebase
 * SDK: two verbs on one path is all this needs, `HttpClient` already speaks
 * them, and the endpoint answers CORS — so the app gains cross-device sync
 * without gaining a dependency.
 *
 * This is the same `safevault-fcbdc` project and `users/$uid` tree the
 * Android and TV apps already sync addons and list preferences under — see
 * `database.rules.json` — so a device signed into the same Google account on
 * any of the three shares the same list. Earlier this pointed at a different
 * project, keyed by a hash of the mdblist key instead of a real `auth.uid`;
 * that path had no matching rule on this project and so could never have
 * synced anything, on top of never being reachable from the native apps
 * either. Google sign-in fixes both at once.
 */
const DB = 'https://safevault-fcbdc-default-rtdb.firebaseio.com';
const STORAGE_KEY = 'mdblist-hub.sync';
/** Collapses a burst of installs into a single write. */
const PUSH_DELAY = 1500;

interface Payload {
  updatedAt: string;
  addons: InstalledAddon[];
}

/**
 * A refusal worth explaining, as opposed to the transport failing.
 *
 * `request` below turns every error into "não foi possível falar com o
 * Firebase", which is right for a dropped connection and actively misleading
 * for a sync that reached the database, read it fine, and declined to apply
 * what it found. Carrying a distinct type is what lets that one case keep its
 * own message.
 */
class SyncRefusal extends Error {}

@Injectable({ providedIn: 'root' })
export class AddonSyncService {
  private readonly http = inject(HttpClient);
  private readonly addons = inject(AddonsService);
  private readonly googleAuth = inject(GoogleAuthService);

  private readonly on = signal<boolean>(localStorage.getItem(STORAGE_KEY) === 'on');
  private readonly last = signal<string | null>(null);
  private readonly failure = signal<string | null>(null);
  private readonly working = signal(false);

  readonly enabled = this.on.asReadonly();
  readonly lastSync = this.last.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly busy = this.working.asReadonly();

  /** Set while a pull is being applied, so it does not echo straight back. */
  private applying = false;
  private pushTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Any change to the local list — installed, removed, imported from Stremio
    // — becomes a write, debounced so a bulk import is one request.
    effect(() => {
      const addons = this.addons.installed();
      if (!this.on() || this.applying || !this.googleAuth.linked()) return;

      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.push(addons).subscribe(), PUSH_DELAY);
    });
  }

  /**
   * Turns sync on by joining the two lists: whatever is stored plus whatever
   * this browser already had, pushed back so both sides agree. Only turning it
   * on unions — from then on the stored list is the shared truth.
   */
  enable(): Observable<number> {
    localStorage.setItem(STORAGE_KEY, 'on');
    this.on.set(true);

    return this.request((uid, idToken) =>
      this.read(uid, idToken).pipe(
        switchMap((remote) => {
          const fresh = this.apply(() => this.addons.merge(remote));
          return this.write(uid, idToken, this.addons.installed()).pipe(map(() => fresh));
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

  /**
   * Makes this browser match what is stored, removals included.
   *
   * Deliberately a replace and not a merge: `push` writes the whole list, so
   * an addon removed elsewhere is simply absent from the stored copy. Merging
   * here would read that absence as "nothing to add" and the deletion would
   * never arrive — worse, the next push would put it back.
   *
   * An empty read is the one thing never applied. It is ambiguous — a
   * genuinely empty list is indistinguishable from a `uid` never written to, a
   * payload that failed to parse, or Firebase answering `null`, all of which
   * `read` flattens to `[]`. Replacing on that wipes a working set of addons
   * and leaves nothing behind, and because the effect in the constructor
   * pushes every local change straight back, the empty list would then be
   * written to the database and travel on to every other device. So the
   * destructive reading is refused outright and the local list is kept.
   */
  pull(): Observable<number> {
    return this.request((uid, idToken) =>
      this.read(uid, idToken).pipe(
        map((remote) => {
          if (!remote.length) {
            throw new SyncRefusal(
              translate('The cloud returned no addons, so the local list was left unchanged. Use “Upload” first on the device with the correct addons.'),
            );
          }

          const before = this.addons.installed().length;
          this.apply(() => this.addons.replaceAll(remote));
          return Math.abs(remote.length - before);
        }),
      ),
    );
  }

  /** Writes the local list out, replacing whatever was there. */
  push(addons = this.addons.installed()): Observable<number> {
    return this.request((uid, idToken) =>
      this.write(uid, idToken, addons).pipe(map(() => addons.length)),
    );
  }

  private read(uid: string, idToken: string): Observable<InstalledAddon[]> {
    return this.http
      .get<Payload | null>(`${DB}/users/${uid}/addons.json`, {
        params: { auth: idToken },
        context: noCache(),
      })
      .pipe(map((payload) => payload?.addons ?? []));
  }

  private write(uid: string, idToken: string, addons: InstalledAddon[]): Observable<unknown> {
    return this.http.put(
      `${DB}/users/${uid}/addons.json`,
      { updatedAt: new Date().toISOString(), addons } satisfies Payload,
      { params: { auth: idToken }, context: noCache() },
    );
  }

  /**
   * Runs a local mutation with the write-back guard held. The guard has to span
   * the signal update itself, not just the call, or the effect above would push
   * straight back what was only just read.
   */
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
      const message = translate('Connect your Google account first.');
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
          refused ? cause.message : translate('Could not reach Firebase. Check your connection.'),
        );
        return throwError(() => (refused ? cause : new Error('sync failed')));
      }),
    );
  }
}
