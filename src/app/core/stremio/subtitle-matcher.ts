import type { SubtitleOption } from './models';
import { currentLanguage } from '../i18n.service';

/**
 * Picks the subtitle most likely to be synchronized with the playing release.
 * Portuguese is preferred over English; within that language, release tokens
 * (quality, source, codec and release group) win over raw popularity.
 */
export function bestSubtitleMatch(
  options: SubtitleOption[],
  playingRelease: string | null,
): SubtitleOption | null {
  const releaseTokens = tokens(playingRelease ?? '');
  const preferred = currentLanguage() === 'pt' ? looksPortuguese : looksEnglish;
  const fallback = currentLanguage() === 'pt' ? looksEnglish : looksPortuguese;
  return bestOf(options.filter((option) => preferred(option.lang)), releaseTokens) ??
    bestOf(options.filter((option) => fallback(option.lang)), releaseTokens);
}

function bestOf(candidates: SubtitleOption[], releaseTokens: Set<string>): SubtitleOption | null {
  let best: SubtitleOption | null = null;
  let bestOverlap = -1;
  let bestPopularity = -1;

  for (const candidate of candidates) {
    const overlap = intersectionSize(tokens(candidate.releaseHint ?? ''), releaseTokens);
    if (
      overlap > bestOverlap ||
      (overlap === bestOverlap && candidate.popularity > bestPopularity)
    ) {
      best = candidate;
      bestOverlap = overlap;
      bestPopularity = candidate.popularity;
    }
  }
  return best;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let size = 0;
  for (const token of left) if (right.has(token)) size += 1;
  return size;
}

function tokens(text: string): Set<string> {
  const normalized = ALIASES.reduce(
    (value, [pattern, canonical]) => value.replace(pattern, canonical),
    text.toLowerCase(),
  );
  return new Set(
    (normalized.match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3 && !NOISE.has(word)),
  );
}

function looksPortuguese(code: string | null | undefined): boolean {
  const key = (code ?? '').toLowerCase();
  return key.startsWith('po') || key.startsWith('pt');
}

function looksEnglish(code: string | null | undefined): boolean {
  return (code ?? '').toLowerCase().startsWith('en');
}

const NOISE = new Set([
  'the',
  'and',
  'www',
  'com',
  'org',
  'net',
  'http',
  'https',
  'srt',
  'sub',
  'subs',
  'subtitle',
  'subtitles',
  'por',
  'pob',
  'pt',
  'br',
  'eng',
  'en',
]);

const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/x\.?264|h\.?264|avc/g, 'h264'],
  [/x\.?265|h\.?265|hevc/g, 'hevc'],
  [/web[.\-\s]?dl/g, 'webdl'],
  [/web[.\-\s]?rip/g, 'webrip'],
  [/blu[.\-\s]?ray/g, 'bluray'],
  [/dvd[.\-\s]?rip/g, 'dvdrip'],
  [/bd[.\-\s]?rip/g, 'bdrip'],
  [/hd[.\-\s]?rip/g, 'hdrip'],
  [/hd[.\-\s]?tv/g, 'hdtv'],
  [/\b4k\b|2160p|uhd/g, '2160p'],
];
