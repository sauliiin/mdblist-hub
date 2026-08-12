import { ListPref, MdbList } from './models';

/**
 * The curated set of lists the site shows **to the owner**, keyed by their
 * exact mdblist name (lowercased) and mapped to a Portuguese label. Lists
 * outside this map are hidden, and rows are ordered alphabetically by the
 * translated label. Any other visitor sees every list they own instead, via
 * `alphabetical()`.
 */
const CATALOG: Record<string, string> = {
  'ação e aventura': 'Ação e Aventura',
  'animation': 'Animação',
  'combina com você': 'Combina com Você',
  'trending movies': 'Em Alta',
  'fantasia': 'Fantasia',
  'science fiction': 'Ficção Científica',
  "can't go wrong movies": 'Filmes Que Não Têm Erro',
  'surprise me': 'Me Surpreenda',
  'best of super heroe': 'O Melhor dos Super-Heróis',
  'best ever': 'Os Melhores de Todos os Tempos',
  "series can't go wrong": 'Séries Que Não Têm Erro',
  'supernatural': 'Sobrenatural',
  'suspense': 'Suspense',
  'horror': 'Terror',
  'lastest movie releases': 'Últimos Lançamentos',
  'zombies and outbreak': 'Zumbis e Epidemias',
};

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/**
 * Keeps only the catalogued lists, swaps in the Portuguese name and sorts them
 * alphabetically. The raw mdblist name stays available as `originalName`.
 */
export function curate(lists: MdbList[]): MdbList[] {
  return lists
    .filter((list) => CATALOG[key(list)])
    .map((list) => ({ ...list, originalName: list.name, name: CATALOG[key(list)] }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * The view for every other account: nothing hidden, nothing renamed — just
 * their own lists in alphabetical order.
 */
export function alphabetical(lists: MdbList[]): MdbList[] {
  return [...lists].sort((a, b) => collator.compare(a.name, b.name));
}

function key(list: MdbList): string {
  return list.name.trim().toLowerCase();
}

/**
 * Layers a visitor's own rename/hide/reorder on top of the curated or
 * alphabetical list, in that order: hidden ones drop out (unless
 * `includeHidden`, used by the home page's edit mode so a hidden list stays
 * reachable to un-hide), then names are overridden, then anything with an
 * explicit `position` moves to the front in that order — everything else
 * keeps arriving in whatever order `curate()`/`alphabetical()` already gave it.
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
