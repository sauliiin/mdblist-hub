import { Injectable, signal } from '@angular/core';

const FONT_STORAGE_KEY = 'mdblist-hub.subtitle-prefs';
const COLOR_STORAGE_KEY = 'mdblist-hub.subtitle-prefs.color';

export interface SubtitleFontOption {
  key: string;
  label: string;
  /** CSS `font-family` value, applied to `::cue` through a custom property. */
  value: string;
}

export interface SubtitleColorOption {
  key: string;
  label: string;
  /** CSS color value, applied to `::cue` through a custom property. */
  value: string;
}

/** Web-safe families only — no new font files, so every choice renders everywhere. */
export const SUBTITLE_FONT_OPTIONS: readonly SubtitleFontOption[] = [
  { key: 'default', label: 'Default', value: 'inherit' },
  { key: 'serif', label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { key: 'rounded', label: 'Rounded', value: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { key: 'mono', label: 'Monospace', value: '"Courier New", ui-monospace, monospace' },
];

/**
 * Same four choices the native apps offer (`SettingsScreen.kt`). The default
 * here stays `yellow`, not native's `white`, since the web player has always
 * rendered yellow by default — a synced account still correctly overrides it.
 */
export const SUBTITLE_COLOR_OPTIONS: readonly SubtitleColorOption[] = [
  { key: 'yellow', label: 'Yellow', value: '#ffeb3b' },
  { key: 'white', label: 'White', value: '#ffffff' },
  { key: 'red', label: 'Red', value: '#ff0000' },
  { key: 'blue', label: 'Blue', value: '#0000ff' },
];

const DEFAULT_FONT_KEY = SUBTITLE_FONT_OPTIONS[0].key;
const DEFAULT_COLOR_KEY = SUBTITLE_COLOR_OPTIONS[0].key;

/**
 * The chosen legend font and color, persisted locally and — once a Google
 * account is linked — mirrored across devices by `PreferencesSyncService`.
 */
@Injectable({ providedIn: 'root' })
export class SubtitlePrefsService {
  private readonly font = signal<string>(storedFont());
  private readonly color = signal<string>(storedColor());

  readonly fontKey = this.font.asReadonly();
  readonly colorKey = this.color.asReadonly();

  setFont(key: string): void {
    if (!SUBTITLE_FONT_OPTIONS.some((option) => option.key === key)) return;

    localStorage.setItem(FONT_STORAGE_KEY, key);
    this.font.set(key);
  }

  setColor(key: string): void {
    if (!SUBTITLE_COLOR_OPTIONS.some((option) => option.key === key)) return;

    localStorage.setItem(COLOR_STORAGE_KEY, key);
    this.color.set(key);
  }
}

function storedFont(): string {
  const saved = localStorage.getItem(FONT_STORAGE_KEY);
  return saved && SUBTITLE_FONT_OPTIONS.some((option) => option.key === saved)
    ? saved
    : DEFAULT_FONT_KEY;
}

function storedColor(): string {
  const saved = localStorage.getItem(COLOR_STORAGE_KEY);
  return saved && SUBTITLE_COLOR_OPTIONS.some((option) => option.key === saved)
    ? saved
    : DEFAULT_COLOR_KEY;
}
