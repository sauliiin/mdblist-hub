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
 * hidden ones drop out (unless `includeHidden`, used by the home page's edit
 * mode so a hidden list stays reachable to un-hide), then names are
 * overridden, then anything with an explicit `position` moves to the front in
 * that order — everything else keeps arriving in whatever order
 * `alphabetical()` already gave it. This is what makes list curation general
 * — every visitor gets the same tools to shape their own home, rather than
 * one hardcoded account getting a pre-curated set.
 */
export function applyPrefs(
  lists: MdbList[],
  prefs: ListPref[],
  options: { includeHidden?: boolean } = {},
): MdbList[] {
  const byId = new Map(prefs.map((p) => [p.id, p]));

  const visible = options.includeHidden ? lists : lists.filter((l) => !byId.get(l.id)?.hidden);
  const named = visible.map((list) => {
    const name = byId.get(list.id)?.name;
    return name ? { ...list, name } : list;
  });

  const positioned = named
    .filter((l) => byId.get(l.id)?.position !== undefined)
    .sort((a, b) => byId.get(a.id)!.position! - byId.get(b.id)!.position!);
  const rest = named.filter((l) => byId.get(l.id)?.position === undefined);

  return [...positioned, ...rest];
}
