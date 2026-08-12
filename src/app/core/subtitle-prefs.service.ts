import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'mdblist-hub.subtitle-prefs';

export interface SubtitleFontOption {
  key: string;
  label: string;
  /** CSS `font-family` value, applied to `::cue` through a custom property. */
  value: string;
}

/** Web-safe families only — no new font files, so every choice renders everywhere. */
export const SUBTITLE_FONT_OPTIONS: readonly SubtitleFontOption[] = [
  { key: 'default', label: 'Padrão', value: 'inherit' },
  { key: 'serif', label: 'Serifada', value: 'Georgia, "Times New Roman", serif' },
  { key: 'rounded', label: 'Arredondada', value: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { key: 'mono', label: 'Monoespaçada', value: '"Courier New", ui-monospace, monospace' },
];

const DEFAULT_KEY = SUBTITLE_FONT_OPTIONS[0].key;

/**
 * The chosen legend font, persisted locally and — once a Google account is
 * linked — mirrored across devices by `PreferencesSyncService`.
 */
@Injectable({ providedIn: 'root' })
export class SubtitlePrefsService {
  private readonly font = signal<string>(stored());

  readonly fontKey = this.font.asReadonly();

  setFont(key: string): void {
    if (!SUBTITLE_FONT_OPTIONS.some((option) => option.key === key)) return;

    localStorage.setItem(STORAGE_KEY, key);
    this.font.set(key);
  }
}

function stored(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && SUBTITLE_FONT_OPTIONS.some((option) => option.key === saved)
    ? saved
    : DEFAULT_KEY;
}
