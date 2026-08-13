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
   * they are displayed right now, hidden ones included.
   *
   * Every list in `currentOrder` gets an explicit `position` here, not just
   * the pair changing places: `applyPrefs()` sorts every list carrying a
   * `position` *before* every list that still lacks one, so writing a
   * position on only the two being swapped used to yank both of them ahead
   * of every other untouched, unpositioned list in one move — not just past
   * their immediate neighbour. A list sitting between the moved one and the
   * top that had never been touched would silently get skipped over (or
   * shoved back down) instead of stepped past one at a time, which is what
   * made climbing to the top row by row not actually work.
   */
  move(id: number, direction: -1 | 1, currentOrder: readonly number[]): void {
    const index = currentOrder.indexOf(id);
    const neighborIndex = index + direction;
    if (index < 0 || neighborIndex < 0 || neighborIndex >= currentOrder.length) return;

    const next = [...currentOrder];
    [next[index], next[neighborIndex]] = [next[neighborIndex], next[index]];

    const byId = new Map(this.prefs().map((p) => [p.id, p]));
    this.prefs.set(next.map((listId, position) => ({ ...(byId.get(listId) ?? { id: listId }), position })));
    this.persist();
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
