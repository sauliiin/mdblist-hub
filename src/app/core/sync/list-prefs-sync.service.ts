import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, from, map, switchMap, throwError } from 'rxjs';
import { AuthService } from '../auth.service';
import { GoogleAuthService } from '../google-auth.service';
import { noCache } from '../http-cache.interceptor';
import { ListPrefsService } from '../list-prefs.service';
import { ListPref } from '../models';

/**
 * Same `safevault-fcbdc` Realtime Database project as `addon-sync.service.ts`,
 * but `users/$uid/listPreferences` rather than a `listPrefs` node of our own:
 * the deployed rules (checked into the native apps' repo, `database.rules.json`)
 * only allow `profile`/`addons`/`preferences`/`listPreferences` under a user —
 * an earlier `listPrefs` name silently failed every write with 401, since
 * nothing in the schema recognised that key.
 *
 * The native shape nests custom lists under `lists` (index-keyed, `id > 0`)
 * alongside a `catalogs` node this app doesn't populate — Stremio addon
 * catalogs, ordered on the native home screen the same way a list is, which
 * has no equivalent here yet. Writes go through PATCH rather than PUT so a
 * push from here never wipes out whatever `catalogs` (or anything else) a
 * native client already wrote at that same path.
 *
 * The two built-in "Watchlist"/"Coleção" rows (see `Home`'s `HomeRow`) use
 * reserved negative ids the native schema has no room for (`lists.$index.id`
 * must be `> 0`) and no native client can act on anyway, so their prefs never
 * leave this browser — filtered out before every write, and re-attached
 * after every read so a pull doesn't erase them.
 */
const DB = 'https://safevault-fcbdc-default-rtdb.firebaseio.com';
const STORAGE_KEY = 'mdblist-hub.list-prefs-sync';
/** Collapses a burst of rename/hide/reorder into a single write. */
const PUSH_DELAY = 1500;

/** One entry of `listPreferences/lists` — mirrors the native apps' own shape exactly. */
interface RemoteListEntry {
  id: number;
  name?: string;
  position?: number;
  hidden?: boolean;
  /** Native-only concept, never set here — treated as `hidden` on read, see `fromRemoteEntry`. */
  deleted?: boolean;
}

interface Payload {
  updatedAt: string;
  /** Required by the deployed rules; whose lists a `listPreferences` node holds. */
  mdblistUserId: number;
  lists?: Record<string, RemoteListEntry>;
}

/** Mirrors `AddonSyncService`'s `SyncRefusal` — see that file for the reasoning. */
class SyncRefusal extends Error {}

@Injectable({ providedIn: 'root' })
export class ListPrefsSyncService {
  private readonly http = inject(HttpClient);
  private readonly listPrefs = inject(ListPrefsService);
  private readonly googleAuth = inject(GoogleAuthService);
  private readonly auth = inject(AuthService);

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

  /**
   * Makes this browser match what is stored, including removals — see
   * `AddonSyncService.pull()`. The two built-in rows are never part of what's
   * stored (see the class doc comment), so whatever this browser had for
   * them locally rides along untouched rather than being wiped by the replace.
   */
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

          const localOnly = this.listPrefs.all().filter((p) => p.id < 0);
          const next = [...remote, ...localOnly];
          const before = this.listPrefs.all().length;
          this.apply(() => this.listPrefs.replaceAll(next));
          return Math.abs(next.length - before);
        }),
      ),
    );
  }

  push(prefs = this.listPrefs.all()): Observable<number> {
    return this.request((uid, idToken) => this.write(uid, idToken, prefs).pipe(map(() => prefs.length)));
  }

  private read(uid: string, idToken: string): Observable<ListPref[]> {
    return this.http
      .get<Payload | null>(`${DB}/users/${uid}/listPreferences.json`, {
        params: { auth: idToken },
        context: noCache(),
      })
      .pipe(map((payload) => Object.values(payload?.lists ?? {}).map(fromRemoteEntry)));
  }

  /**
   * PATCH, not PUT: a `listPreferences` node can carry a native-only
   * `catalogs` sibling this app never reads — overwriting the whole node
   * would silently delete it out from under a phone or TV signed into the
   * same account.
   */
  private write(uid: string, idToken: string, prefs: ListPref[]): Observable<unknown> {
    const entries = prefs.filter((p) => p.id > 0);
    const lists = Object.fromEntries(entries.map((p, i) => [String(i), toRemoteEntry(p)]));
    const payload: Payload = {
      updatedAt: new Date().toISOString(),
      mdblistUserId: this.auth.user()?.user_id ?? 0,
      lists,
    };

    return this.http.patch(`${DB}/users/${uid}/listPreferences.json`, payload, {
      params: { auth: idToken },
      context: noCache(),
    });
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

function toRemoteEntry(pref: ListPref): RemoteListEntry {
  return { id: pref.id, name: pref.name, position: pref.position, hidden: pref.hidden };
}

function fromRemoteEntry(entry: RemoteListEntry): ListPref {
  return {
    id: entry.id,
    name: entry.name,
    position: entry.position,
    hidden: entry.hidden || entry.deleted || undefined,
  };
}
