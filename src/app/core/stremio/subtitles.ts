/**
 * Turning an addon's subtitle file into something `<track>` accepts.
 *
 * `<track>` only reads WebVTT, and subtitle addons overwhelmingly serve SubRip
 * (`.srt`). So the file is fetched as bytes, decoded, converted here and handed
 * to the player as a `blob:` URL — which also sidesteps the fact that `<track>`
 * enforces CORS on its `src` while a Blob has no origin to check.
 */

/** Timestamps: `00:01:02,500` in SRT, `00:01:02.500` in VTT. */
const CUE_TIME = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
/** ASS/SSA position overrides some SRT files carry — meaningless in VTT. */
const ASS_OVERRIDE = /\{\\[^}]*\}/g;

/**
 * Decodes a subtitle file.
 *
 * Portuguese subtitles are still frequently published as windows-1252, and a
 * UTF-8 decode of those turns every accented character into U+FFFD. So the
 * declared encoding wins, and otherwise a UTF-8 attempt that comes back with
 * replacement characters is retried as windows-1252.
 */
export function decodeSubtitle(bytes: ArrayBuffer, declared?: string | null): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const fallback = declared || 'windows-1252';
    try {
      return new TextDecoder(fallback).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

/**
 * Converts SubRip to WebVTT. Files that already are WebVTT pass through with
 * only their line endings normalised.
 */
export function srtToVtt(input: string): string {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^\s*WEBVTT/.test(text)) return text;

  const body = text
    .replace(ASS_OVERRIDE, '')
    // VTT wants a dot and exactly three fraction digits.
    .replace(CUE_TIME, (_, h: string, m: string, s: string, ms: string) =>
      `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`,
    )
    // Drop SRT's sequence numbers. Left in place they would be read as cue
    // identifiers, which is legal but shows up in some players' cue lists.
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.)/gm, '')
    // Raise subtitles slightly (standard for movies) by appending line:82% to the timestamp line
    .replace(/(-->\s*\d{2}:\d{2}:\d{2}\.\d{3})(.*)/g, '$1 line:82% align:center$2');

  return `WEBVTT\n\n${body.trim()}\n`;
}

/** ISO 639-2/B codes the addons use, for a readable dropdown. */
const LANGUAGES: Record<string, string> = {
  por: 'Português', pob: 'Português (BR)', pt: 'Português', 'pt-br': 'Português (BR)',
  eng: 'Inglês', en: 'Inglês',
  spa: 'Espanhol', es: 'Espanhol',
  fre: 'Francês', fra: 'Francês', fr: 'Francês',
  ger: 'Alemão', deu: 'Alemão', de: 'Alemão',
  ita: 'Italiano', it: 'Italiano',
  jpn: 'Japonês', ja: 'Japonês',
  kor: 'Coreano', ko: 'Coreano',
  chi: 'Chinês', zho: 'Chinês', zh: 'Chinês',
  rus: 'Russo', ru: 'Russo',
  ara: 'Árabe', ar: 'Árabe',
  dut: 'Holandês', nld: 'Holandês',
  swe: 'Sueco', nor: 'Norueguês', dan: 'Dinamarquês', fin: 'Finlandês',
  pol: 'Polonês', tur: 'Turco', hin: 'Hindi', heb: 'Hebraico', ell: 'Grego',
};

export function languageLabel(code: string): string {
  const key = (code ?? '').toLowerCase().trim();
  return LANGUAGES[key] ?? (key ? key.toUpperCase() : 'Desconhecido');
}

/**
 * `<track srclang>` is specified as a BCP 47 tag, and the three-letter codes
 * the addons use ("por", "pob") are not one. Browsers are forgiving, but an
 * invalid tag is exactly the kind of thing one of them decides to reject.
 */
export function toBcp47(code: string): string {
  const key = (code ?? '').toLowerCase().trim();
  if (key.startsWith('pob') || key === 'pt-br') return 'pt-BR';
  if (key.startsWith('po') || key.startsWith('pt')) return 'pt';
  if (key.includes('-')) return key;
  return key.slice(0, 2) || 'und';
}

/** Portuguese first, then English, then the rest alphabetically. */
export function languageRank(code: string): number {
  const key = (code ?? '').toLowerCase();
  if (key.startsWith('po') || key.startsWith('pt')) return 0;
  if (key.startsWith('en')) return 1;
  return 2;
}
