import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'mdblist-hub.theme';

export interface ThemeOption {
  key: string;
  label: string;
}

/** Same four appearances the native apps offer — see `HubThemeVariant` (Color.kt). */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { key: 'normal', label: 'Default' },
  { key: 'cyberpunk', label: 'Cyberpunk' },
  { key: 'netflixy', label: 'Netflixy' },
  { key: 'primefly', label: 'Primefly' },
];

/** What a first-time visitor sees, before ever opening the appearance menu. */
const DEFAULT_KEY = 'netflixy';

/**
 * The chosen appearance, persisted locally and — once a Google account is
 * linked — mirrored across devices by `PreferencesSyncService`, the same as
 * the subtitle font/color. Replaces the old unpersisted `isCyberpunk` boolean
 * that used to live on `App` and reset on every reload.
 */
@Injectable({ providedIn: 'root' })
export class ThemePrefsService {
  private readonly theme = signal<string>(stored());

  readonly themeKey = this.theme.asReadonly();

  setTheme(key: string): void {
    if (!THEME_OPTIONS.some((option) => option.key === key)) return;

    localStorage.setItem(STORAGE_KEY, key);
    this.theme.set(key);
  }
}

function stored(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && THEME_OPTIONS.some((option) => option.key === saved) ? saved : DEFAULT_KEY;
}
