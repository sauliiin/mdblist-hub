import { currentLanguage, translate } from '../i18n.service';

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
 * Unpacks the archive a mirror may hand back instead of a subtitle.
 *
 * The same download URL is served as plain text, gzip or a zip depending on
 * which mirror answers, and nothing in the response reliably says which — the
 * Kodi addons that do this dependably all sniff the leading bytes, so this
 * does too. Without it a compressed file reaches [decodeSubtitle] as binary
 * and produces a track with no cues: no error, no subtitle, no explanation.
 *
 * Async because the browser's only unzip/ungzip is `DecompressionStream`.
 * Anything that fails to unpack is returned untouched, so a false positive on
 * two bytes degrades to "try reading it as text" rather than to an error.
 */
export async function unwrapSubtitle(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const view = new Uint8Array(bytes);

  if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
    return (await inflate(bytes, 'gzip')) ?? bytes;
  }
  if (view.length >= 4 && view[0] === 0x50 && view[1] === 0x4b) {
    return (await firstZipEntry(view)) ?? bytes;
  }
  return bytes;
}

async function inflate(data: ArrayBuffer, format: 'gzip' | 'deflate-raw'): Promise<ArrayBuffer | null> {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * The first entry of a zip, read from its local header.
 *
 * Deliberately minimal: subtitle archives hold one file, so walking the
 * central directory to find "the best" entry would be ceremony over a
 * one-element list.
 */
async function firstZipEntry(view: Uint8Array): Promise<ArrayBuffer | null> {
  try {
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    if (dv.getUint32(0, true) !== 0x04034b50) return null;

    const method = dv.getUint16(8, true);
    const compressedSize = dv.getUint32(18, true);
    const nameLength = dv.getUint16(26, true);
    const extraLength = dv.getUint16(28, true);
    const start = 30 + nameLength + extraLength;

    // A zero size means the writer deferred it to a trailing data descriptor;
    // taking the rest of the buffer is correct for a single-entry archive.
    const end = compressedSize > 0 ? start + compressedSize : view.length;
    const body = view.slice(start, end);

    if (method === 0) return body.buffer as ArrayBuffer;
    if (method === 8) return await inflate(body.buffer as ArrayBuffer, 'deflate-raw');
    return null;
  } catch {
    return null;
  }
}

/**
 * Decodes a subtitle file.
 *
 * Portuguese subtitles are still frequently published as windows-1252, and a
 * UTF-8 decode of those turns every accented character into U+FFFD. So the
 * declared encoding wins, and otherwise a UTF-8 attempt that comes back with
 * replacement characters is retried as windows-1252.
 *
 * Decoded per line rather than as one block. A subtitle stitched together
 * over the years by more than one fansubber commonly ends up with most of
 * the file in UTF-8 and a handful of lines still in windows-1252 from
 * whichever tool touched them last — and a *fatal* UTF-8 decode of the whole
 * file throws on that single bad line, which used to fall the entire
 * document back to windows-1252 and mojibake every accent the file actually
 * had right ("não" → "nÃ£o"). Splitting on the raw `\n` byte first and
 * decoding each line on its own merit is what confines a bad line's damage
 * to that line. The split itself is UTF-8-safe: a continuation byte is
 * always ≥ 0x80, so it can never be mistaken for the ASCII `\n` (0x0A).
 */
export function decodeSubtitle(bytes: ArrayBuffer, declared?: string | null): string {
  const view = new Uint8Array(bytes);

  // A BOM is authoritative for the whole file — nothing that adds one part
  // way through a document also leaves the rest correctly encoded.
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(view.subarray(3));
  }

  const utf8 = new TextDecoder('utf-8', { fatal: true });
  // `declared` comes from an addon's metadata and is not a validated charset
  // name — falling back to the one decoder guaranteed to exist rather than
  // letting a garbage string throw out of the constructor itself.
  let fallback: TextDecoder;
  try {
    fallback = new TextDecoder(declared || 'windows-1252');
  } catch {
    fallback = new TextDecoder('windows-1252');
  }

  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i <= view.length; i++) {
    if (i !== view.length && view[i] !== 0x0a) continue;

    const chunk = view.subarray(start, i);
    try {
      lines.push(utf8.decode(chunk));
    } catch {
      lines.push(fallback.decode(chunk));
    }
    start = i + 1;
  }
  return lines.join('\n');
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
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.)/gm, '');

  // Vertical position is set at runtime instead, directly on the parsed
  // `TextTrackCue` objects (see `video-player.ts`'s `positionCues`). Baking a
  // fixed `line:82%` into the text here meant it could never move again once
  // the browser had parsed it — which is exactly wrong on top of the custom
  // bottom control bar this player draws, where a fixed position either
  // sits under the controls when they are visible or leaves an odd gap once
  // they fade. Cue objects stay live for the whole session, so the position
  // can track that instead of being fixed at parse time.
  return `WEBVTT\n\n${body.trim()}\n`;
}

/** ISO 639-2/B codes the addons use, for a readable dropdown. */
const LANGUAGES: Record<string, string> = {
  por: 'Portuguese', pob: 'Portuguese (Brazil)', pt: 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
  eng: 'English', en: 'English',
  spa: 'Spanish', es: 'Spanish',
  fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German',
  ita: 'Italian', it: 'Italian',
  jpn: 'Japanese', ja: 'Japanese',
  kor: 'Korean', ko: 'Korean',
  chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  rus: 'Russian', ru: 'Russian',
  ara: 'Arabic', ar: 'Arabic',
  dut: 'Dutch', nld: 'Dutch',
  swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish',
  pol: 'Polish', tur: 'Turkish', hin: 'Hindi', heb: 'Hebrew', ell: 'Greek',
  hrv: 'Croatian', hr: 'Croatian',
  srp: 'Serbian', sr: 'Serbian',
  bos: 'Bosnian', bs: 'Bosnian',
};

export function languageLabel(code: string): string {
  const key = (code ?? '').toLowerCase().trim();
  return LANGUAGES[key] ? translate(LANGUAGES[key]) : key ? key.toUpperCase() : translate('Unknown');
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
  if (key === 'hrv') return 'hr';
  if (key === 'srp') return 'sr';
  if (key === 'bos') return 'bs';
  if (key.includes('-')) return key;
  return key.slice(0, 2) || 'und';
}

/** UI language first, then the other supported language, then the rest. */
export function languageRank(code: string): number {
  const key = (code ?? '').toLowerCase();
  const portuguese = key.startsWith('po') || key.startsWith('pt');
  const english = key.startsWith('en');
  if (currentLanguage() === 'pt') {
    if (portuguese) return 0;
    if (english) return 1;
  } else {
    if (english) return 0;
    if (portuguese) return 1;
  }
  return 2;
}
