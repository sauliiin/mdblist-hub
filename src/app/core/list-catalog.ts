import { MdbList } from './models';
import { activeLocale } from './i18n.service';

/** What `applyPrefs()` needs from a preference row — `ListPref` and `CatalogPref` both already satisfy this. */
interface RowPref {
  id: number | string;
  name?: string;
  hidden?: boolean;
  position?: number;
}

const collator = new Intl.Collator(activeLocale(), { sensitivity: 'base' });

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
 * "Watchlist"/"Coleção" rows and addon catalog rows through the exact same
 * rename/hide/reorder machinery as a custom list. `id` is `number | string`
 * for the same reason: a custom list's id comes from mdblist, an addon
 * catalog's from `catalogKey()`, and nothing here needs to tell them apart —
 * only `Home.curated()` decides which groups get their own call (so a
 * position saved in one never reorders into another) versus which share one.
 */
export function applyPrefs<T extends { id: number | string; name: string }>(
  items: T[],
  prefs: RowPref[],
): T[] {
  const byId = new Map(prefs.map((p) => [p.id, p]));

  const visible = items.filter((item) => !byId.get(item.id)?.hidden);
  const named = visible.map((item) => {
    const name = byId.get(item.id)?.name;
    if (!name) return item;
    const updated = { ...item, name };
    if ('list' in item && item.list) {
      (updated as any).list = { ...(item.list as any), name };
    }
    return updated as T;
  });

  const positioned = named
    .filter((item) => byId.get(item.id)?.position !== undefined)
    .sort((a, b) => byId.get(a.id)!.position! - byId.get(b.id)!.position!);
  const rest = named.filter((item) => byId.get(item.id)?.position === undefined);

  return [...positioned, ...rest];
}
