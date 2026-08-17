import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'mdblist-hub.alias';

@Injectable({ providedIn: 'root' })
export class AliasPrefsService {
  private readonly aliasSignal = signal<string>(stored());

  readonly alias = this.aliasSignal.asReadonly();

  setAlias(name: string): void {
    const trimmed = name.trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    this.aliasSignal.set(trimmed);
  }
}

function stored(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}
