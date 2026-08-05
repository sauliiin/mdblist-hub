import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, from, map, of, switchMap, throwError } from 'rxjs';
import { AuthService } from '../auth.service';
import { noCache } from '../http-cache.interceptor';
import { AddonsService } from '../stremio/addons.service';
import { InstalledAddon } from '../stremio/models';

/**
 * Realtime Database, reached over its REST interface rather than the Firebase
 * SDK: two verbs on one path is all this needs, `HttpClient` already speaks
 * them, and the endpoint answers CORS — so the app gains cross-device sync
 * without gaining a dependency.
 */
const DB = 'https://alien-bruin-339920-default-rtdb.firebaseio.com';
const ROOT = 'mdblist-hub/addons';
const STORAGE_KEY = 'mdblist-hub.sync';
/** Collapses a burst of installs into a single write. */
const PUSH_DELAY = 1500;

interface Payload {
  updatedAt: string;
  addons: InstalledAddon[];
}

@Injectable({ providedIn: 'root' })
export class AddonSyncService {
  private readonly http = inject(HttpClient);
  private readonly addons = inject(AddonsService);
  private readonly auth = inject(AuthService);

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
  private token: string | null = null;

  constructor() {
    // Any change to the local list — installed, removed, imported from Stremio
    // — becomes a write, debounced so a bulk import is one request.
    effect(() => {
      const addons = this.addons.installed();
      if (!this.on() || this.applying || !this.auth.key()) return;

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

    return this.request((token) =>
      this.read(token).pipe(
        switchMap((remote) => {
          const fresh = this.apply(() => this.addons.merge(remote));
          return this.write(token, this.addons.installed()).pipe(map(() => fresh));
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
   */
  pull(): Observable<number> {
    return this.request((token) =>
      this.read(token).pipe(
        map((remote) => {
          const before = this.addons.installed().length;
          this.apply(() => this.addons.replaceAll(remote));
          return Math.abs(remote.length - before);
        }),
      ),
    );
  }

  /** Writes the local list out, replacing whatever was there. */
  push(addons = this.addons.installed()): Observable<number> {
    return this.request((token) => this.write(token, addons).pipe(map(() => addons.length)));
  }

  private read(token: string): Observable<InstalledAddon[]> {
    return this.http
      .get<Payload | null>(`${DB}/${ROOT}/${token}.json`, { context: noCache() })
      .pipe(map((payload) => payload?.addons ?? []));
  }

  private write(token: string, addons: InstalledAddon[]): Observable<unknown> {
    return this.http.put(
      `${DB}/${ROOT}/${token}.json`,
      { updatedAt: new Date().toISOString(), addons } satisfies Payload,
      { context: noCache() },
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

  private request(call: (token: string) => Observable<number>): Observable<number> {
    if (!this.auth.key()) {
      return throwError(() => new Error('Entre com sua chave do mdblist primeiro.'));
    }

    // `crypto.subtle` only exists in a secure context, so the token cannot be
    // derived over plain http on a LAN address — which is exactly how a phone
    // reaches the dev server. Worth naming: the network error this would
    // otherwise surface as sends people looking in the wrong place.
    if (!crypto?.subtle) {
      const message =
        'A sincronização precisa de https (ou localhost). Neste endereço o navegador não ' +
        'expõe a API de criptografia usada para derivar sua chave de sincronização.';
      this.failure.set(message);
      return throwError(() => new Error(message));
    }

    this.working.set(true);
    this.failure.set(null);

    return from(this.syncToken()).pipe(
      switchMap(call),
      map((count) => {
        this.working.set(false);
        this.last.set(new Date().toISOString());
        return count;
      }),
      catchError(() => {
        this.working.set(false);
        this.failure.set('Não foi possível falar com o Firebase. Verifique sua conexão.');
        return throwError(() => new Error('sync falhou'));
      }),
    );
  }

  /**
   * The path segment the list is stored under: SHA-256 of the mdblist API key.
   *
   * Keying on the key rather than on the account id means the path is itself a
   * secret — someone who knows your mdblist username still cannot construct it.
   * That only holds up if the database rules also refuse to list the children
   * of `mdblist-hub/addons`; see the README.
   */
  private async syncToken(): Promise<string> {
    if (this.token) return this.token;

    const bytes = new TextEncoder().encode(`mdblist-hub:${this.auth.key()}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);

    this.token = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return this.token;
  }
}
