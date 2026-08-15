import { Injectable, signal } from '@angular/core';
import { CatalogPref } from './models';

const STORAGE_KEY = 'mdblist-hub.catalog-prefs';

/**
 * A visitor's own rename/hide/reorder of the addon-catalog rows shown on the
 * home page — the exact counterpart of `ListPrefsService`, one level down:
 * a custom list's identity is `MdbList.id`, an addon catalog's is
 * `catalogKey()`, so this is a separate store keyed by string rather than a
 * generalization of that one. `CatalogPrefsSyncService`-equivalent behaviour
 * lives inside `ListPrefsSyncService`, which pushes both under the same
 * `listPreferences` node the native apps already write — see that file.
 */
@Injectable({ providedIn: 'root' })
export class CatalogPrefsService {
  private readonly prefs = signal<CatalogPref[]>(stored());

  readonly all = this.prefs.asReadonly();

  /** Empty clears the override, falling back to the addon manifest's own name. */
  rename(id: string, name: string): void {
    const trimmed = name.trim();
    this.upsert(id, { name: trimmed || undefined });
  }

  hide(id: string): void {
    this.upsert(id, { hidden: true });
  }

  show(id: string): void {
    this.upsert(id, { hidden: false });
  }

  /** Swaps `id` with its neighbour — see `ListPrefsService.move()`, identical logic. */
  move(id: string, direction: -1 | 1, currentOrder: readonly string[]): void {
    const index = currentOrder.indexOf(id);
    const neighborIndex = index + direction;
    if (index < 0 || neighborIndex < 0 || neighborIndex >= currentOrder.length) return;

    const next = [...currentOrder];
    [next[index], next[neighborIndex]] = [next[neighborIndex], next[index]];

    const byId = new Map(this.prefs().map((p) => [p.id, p]));
    this.prefs.set(next.map((catalogId, position) => ({ ...(byId.get(catalogId) ?? { id: catalogId }), position })));
    this.persist();
  }

  /** Makes the stored set exactly `next` — backs the sync pull, removals included. */
  replaceAll(next: CatalogPref[]): void {
    this.prefs.set(next.filter((p) => typeof p?.id === 'string'));
    this.persist();
  }

  private upsert(id: string, patch: Partial<Omit<CatalogPref, 'id'>>): void {
    this.prefs.update((list) =>
      list.some((p) => p.id === id)
        ? list.map((p) => (p.id === id ? { ...p, ...patch } : p))
        : [...list, { id, ...patch }],
    );
    this.persist();
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs()));
  }
}

function stored(): CatalogPref[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p?.id === 'string') : [];
  } catch {
    return [];
  }
}
