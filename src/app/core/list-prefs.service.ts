import { Injectable, signal } from '@angular/core';
import { ListPref } from './models';

const STORAGE_KEY = 'mdblist-hub.list-prefs';

/**
 * A visitor's own rename/hide/reorder of the lists shown on the home page —
 * purely local customization, layered on top of whatever `MdblistService`
 * fetches. Same shape as `AddonsService`: a signal backed by localStorage,
 * with `ListPrefsSyncService` layered on top for cross-device sync.
 */
@Injectable({ providedIn: 'root' })
export class ListPrefsService {
  private readonly prefs = signal<ListPref[]>(stored());

  readonly all = this.prefs.asReadonly();

  /** Empty clears the override, falling back to the curated/original name. */
  rename(id: number, name: string): void {
    const trimmed = name.trim();
    this.upsert(id, { name: trimmed || undefined });
  }

  hide(id: number): void {
    this.upsert(id, { hidden: true });
  }

  show(id: number): void {
    this.upsert(id, { hidden: false });
  }

  /**
   * Swaps `id` with its neighbour in `currentOrder` — the ids exactly as
   * they are displayed right now, hidden ones included. A list that never
   * had an explicit `position` is given its current display index as one
   * before the swap, so there is always a real number to exchange.
   */
  move(id: number, direction: -1 | 1, currentOrder: readonly number[]): void {
    const index = currentOrder.indexOf(id);
    const neighborIndex = index + direction;
    if (index < 0 || neighborIndex < 0 || neighborIndex >= currentOrder.length) return;

    const neighborId = currentOrder[neighborIndex];
    const positionOf = (listId: number, displayIndex: number) =>
      this.prefs().find((p) => p.id === listId)?.position ?? displayIndex;

    const selfPos = positionOf(id, index);
    const neighborPos = positionOf(neighborId, neighborIndex);

    this.upsert(id, { position: neighborPos });
    this.upsert(neighborId, { position: selfPos });
  }

  /** Makes the stored set exactly `next` — backs the sync pull, removals included. */
  replaceAll(next: ListPref[]): void {
    this.prefs.set(next.filter((p) => typeof p?.id === 'number'));
    this.persist();
  }

  private upsert(id: number, patch: Partial<Omit<ListPref, 'id'>>): void {
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

function stored(): ListPref[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p?.id === 'number') : [];
  } catch {
    return [];
  }
}
