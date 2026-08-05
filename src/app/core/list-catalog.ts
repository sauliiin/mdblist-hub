import { MdbList } from './models';

/**
 * The curated set of lists the site shows, keyed by their exact mdblist name
 * (lowercased) and mapped to a Portuguese label. Lists outside this map are
 * hidden, and rows are ordered alphabetically by the translated label.
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

function key(list: MdbList): string {
  return list.name.trim().toLowerCase();
}
