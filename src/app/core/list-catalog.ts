import { ListPref, MdbList } from './models';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/**
 * The base view for every visitor: nothing hidden, nothing renamed — just
 * their own lists in alphabetical order. `applyPrefs()` below is what lets
 * each visitor customize this to taste.
 */
export function alphabetical(lists: MdbList[]): MdbList[] {
  return [...lists].sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * Layers a visitor's own rename/hide/reorder on top of `alphabetical()`:
 * hidden ones drop out entirely (there is no undo UI for a deleted row yet —
 * see `MediaRow`'s trash button), then names are overridden, then anything
 * with an explicit `position` moves to the front in that order — everything
 * else keeps arriving in whatever order `alphabetical()` already gave it.
 * This is what makes list curation general — every visitor gets the same
 * tools to shape their own home, rather than one hardcoded account getting a
 * pre-curated set.
 *
 * Generic rather than `MdbList`-specific so `Home` can run the built-in
 * "Watchlist"/"Coleção" rows through the exact same rename/hide/reorder
 * machinery as a custom list, interleaved with them in one shared order.
 */
export function applyPrefs<T extends { id: number; name: string }>(items: T[], prefs: ListPref[]): T[] {
  const byId = new Map(prefs.map((p) => [p.id, p]));

  const visible = items.filter((item) => !byId.get(item.id)?.hidden);
  const named = visible.map((item) => {
    const name = byId.get(item.id)?.name;
    return name ? ({ ...item, name } as T) : item;
  });

  const positioned = named
    .filter((item) => byId.get(item.id)?.position !== undefined)
    .sort((a, b) => byId.get(a.id)!.position! - byId.get(b.id)!.position!);
  const rest = named.filter((item) => byId.get(item.id)?.position === undefined);

  return [...positioned, ...rest];
}
