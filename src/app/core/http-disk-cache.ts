/**
 * Disk layer of the HTTP cache: JSON response bodies persisted in IndexedDB,
 * so a cold start can paint the home from the last session instead of waiting
 * on 25 list requests. All operations degrade to no-ops when IndexedDB is
 * unavailable (private mode, ancient WebView) — the in-memory cache in
 * `http-cache.interceptor.ts` still works on its own.
 */

export interface StoredResponse {
  /** `urlWithParams` of the request — same key the memory cache uses. */
  url: string;
  body: unknown;
  status: number;
  storedAt: number;
}

const DB_NAME = 'mdblist-hub-http-cache';
const STORE = 'responses';

/** Entries older than this are dropped rather than served, even stale. */
export const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore(STORE, { keyPath: 'url' });
        request.onsuccess = () => {
          resolve(request.result);
          prune(request.result);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

/** Deletes expired entries; runs once per session, right after opening. */
function prune(database: IDBDatabase): void {
  try {
    const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
    const cutoff = Date.now() - DISK_MAX_AGE_MS;
    store.openCursor().onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) return;
      if ((cursor.value as StoredResponse).storedAt < cutoff) cursor.delete();
      cursor.continue();
    };
  } catch {
    /* a failed prune only means stale entries linger until next time */
  }
}

export async function readStored(url: string): Promise<StoredResponse | null> {
  const database = await db();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(url);
      request.onsuccess = () => resolve((request.result as StoredResponse) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeStored(entry: StoredResponse): Promise<void> {
  const database = await db();
  if (!database) return;
  try {
    database.transaction(STORE, 'readwrite').objectStore(STORE).put(entry);
  } catch {
    /* body not structured-cloneable or quota exceeded — skip persisting */
  }
}

export async function clearStored(): Promise<void> {
  const database = await db();
  if (!database) return;
  try {
    database.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  } catch {
    /* nothing to do — the account-scoped keys stop matching anyway */
  }
}
