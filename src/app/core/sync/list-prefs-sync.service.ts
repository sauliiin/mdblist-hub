import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable, catchError, from, map, switchMap, throwError } from 'rxjs';
import { AuthService } from '../auth.service';
import { GoogleAuthService } from '../google-auth.service';
import { noCache } from '../http-cache.interceptor';
import { CatalogPrefsService } from '../catalog-prefs.service';
import { ListPrefsService } from '../list-prefs.service';
import { CatalogPref, ListPref } from '../models';

/**
 * Same `safevault-fcbdc` Realtime Database project as `addon-sync.service.ts`,
 * but `users/$uid/listPreferences` rather than a `listPrefs` node of our own:
 * the deployed rules (checked into the native apps' repo, `database.rules.json`)
 * only allow `profile`/`addons`/`preferences`/`listPreferences` under a user —
 * an earlier `listPrefs` name silently failed every write with 401, since
 * nothing in the schema recognised that key.
 *
 * The native shape nests custom lists under `lists` (index-keyed, `id > 0`)
 * alongside `catalogs` (index-keyed, `key` a string) — Stremio addon
 * catalogs, ordered/renamed/hidden the same way a list is. Both ride the
 * same toggle and the same push/pull here, one PATCH apiece, because that is
 * how the native apps write them: one `FirebaseListPreferencesDto` with
 * `lists` and `catalogs` as siblings — see the native repo's `SyncDto.kt`.
 * PATCH rather than PUT is still what matters most: it is what stops a push
 * from here ever wiping out whichever of the two a native client wrote most
 * recently, on the same path, for the other kind.
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

/** One entry of `listPreferences/catalogs` — mirrors `FirebaseCatalogPreferenceDto` exactly. */
interface RemoteCatalogEntry {
  key: string;
  name?: string;
  position?: number;
  hidden?: boolean;
  /** Native-only concept, never set here — treated as `hidden` on read, see `fromRemoteCatalogEntry`. */
  deleted?: boolean;
}

interface Payload {
  updatedAt: string;
  /** Required by the deployed rules; whose lists a `listPreferences` node holds. */
  mdblistUserId: number;
  lists?: Record<string, RemoteListEntry>;
  catalogs?: Record<string, RemoteCatalogEntry>;
}

/** Mirrors `AddonSyncService`'s `SyncRefusal` — see that file for the reasoning. */
class SyncRefusal extends Error {}

@Injectable({ providedIn: 'root' })
export class ListPrefsSyncService {
  private readonly http = inject(HttpClient);
  private readonly listPrefs = inject(ListPrefsService);
  private readonly catalogPrefs = inject(CatalogPrefsService);
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
      const lists = this.listPrefs.all();
      const catalogs = this.catalogPrefs.all();
      if (!this.on() || this.applying || !this.googleAuth.linked()) return;

      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.push(lists, catalogs).subscribe(), PUSH_DELAY);
    });
  }

  /** Joins whatever is stored with whatever this browser already had, then pushes both back in sync. */
  enable(): Observable<number> {
    localStorage.setItem(STORAGE_KEY, 'on');
    this.on.set(true);

    return this.request((uid, idToken) =>
      this.read(uid, idToken).pipe(
        switchMap(({ lists, catalogs }) => {
          const mergedLists = mergePrefs(this.listPrefs.all(), lists);
          const mergedCatalogs = mergePrefs(this.catalogPrefs.all(), catalogs);
          this.apply(() => {
            this.listPrefs.replaceAll(mergedLists);
            this.catalogPrefs.replaceAll(mergedCatalogs);
          });
          return this.write(uid, idToken, mergedLists, mergedCatalogs).pipe(
            map(() => mergedLists.length + mergedCatalogs.length),
          );
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
        map(({ lists, catalogs }) => {
          if (!lists.length && !catalogs.length) {
            throw new SyncRefusal(
              'A nuvem não devolveu nenhuma preferência de lista, então não mexi nas daqui. ' +
                'Use "Enviar" no aparelho que tem as listas certas primeiro.',
            );
          }

          const localOnlyLists = this.listPrefs.all().filter((p) => p.id < 0);
          const nextLists = [...lists, ...localOnlyLists];
          const before = this.listPrefs.all().length + this.catalogPrefs.all().length;
          this.apply(() => {
            this.listPrefs.replaceAll(nextLists);
            this.catalogPrefs.replaceAll(catalogs);
          });
          return Math.abs(nextLists.length + catalogs.length - before);
        }),
      ),
    );
  }

  push(lists = this.listPrefs.all(), catalogs = this.catalogPrefs.all()): Observable<number> {
    return this.request((uid, idToken) =>
      this.write(uid, idToken, lists, catalogs).pipe(map(() => lists.length + catalogs.length)),
    );
  }

  private read(uid: string, idToken: string): Observable<{ lists: ListPref[]; catalogs: CatalogPref[] }> {
    return this.http
      .get<Payload | null>(`${DB}/users/${uid}/listPreferences.json`, {
        params: { auth: idToken },
        context: noCache(),
      })
      .pipe(
        map((payload) => ({
          lists: Object.values(payload?.lists ?? {}).map(fromRemoteEntry),
          catalogs: Object.values(payload?.catalogs ?? {}).map(fromRemoteCatalogEntry),
        })),
      );
  }

  /**
   * PATCH, not PUT: a `listPreferences` node's two children are each written
   * whole here, but PATCH is what stops this call from wiping out whichever
   * *other* top-level field (today, just the other of `lists`/`catalogs`,
   * but the schema is shared with two native apps and does not promise to
   * stay that short) a phone or TV last wrote at this same path.
   */
  private write(
    uid: string,
    idToken: string,
    lists: ListPref[],
    catalogs: CatalogPref[],
  ): Observable<unknown> {
    const listEntries = lists.filter((p) => p.id > 0);
    const payload: Payload = {
      updatedAt: new Date().toISOString(),
      mdblistUserId: this.auth.user()?.user_id ?? 0,
      lists: Object.fromEntries(listEntries.map((p, i) => [String(i), toRemoteEntry(p)])),
      catalogs: Object.fromEntries(catalogs.map((p, i) => [String(i), toRemoteCatalogEntry(p)])),
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
function mergePrefs<T extends { id: number | string }>(local: T[], remote: T[]): T[] {
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

function toRemoteCatalogEntry(pref: CatalogPref): RemoteCatalogEntry {
  return { key: pref.id, name: pref.name, position: pref.position, hidden: pref.hidden };
}

function fromRemoteCatalogEntry(entry: RemoteCatalogEntry): CatalogPref {
  return {
    id: entry.key,
    name: entry.name,
    position: entry.position,
    hidden: entry.hidden || entry.deleted || undefined,
  };
}
