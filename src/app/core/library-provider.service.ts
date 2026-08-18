import { Injectable, computed, inject, signal } from '@angular/core';
import { TraktAuthService } from './trakt/trakt-auth.service';

export type LibraryProvider = 'mdblist' | 'trakt';

const STORAGE_KEY = 'mdblist-hub.library-provider';

/**
 * Which account answers for watchlist, collection, watched and the playback
 * position behind "continue watching" — the same setting the native apps
 * carry, and with the same reach: it changes where those five things are read
 * from and written to, and nothing else. The lists on the home page are
 * mdblist's either way, because they are what this site is for.
 *
 * The preference and the effective provider are separate on purpose. Someone
 * can pick Trakt, unlink the account and come back later: the choice is still
 * theirs, but until a token exists there is nothing to ask, so every read
 * falls back to mdblist rather than failing.
 */
@Injectable({ providedIn: 'root' })
export class LibraryProviderService {
  private readonly trakt = inject(TraktAuthService);

  private readonly selected = signal<LibraryProvider>(stored());

  /** What the user picked, whether or not it can be honoured right now. */
  readonly preference = this.selected.asReadonly();

  /** What is actually answering. */
  readonly provider = computed<LibraryProvider>(() =>
    this.selected() === 'trakt' && this.trakt.linked() ? 'trakt' : 'mdblist',
  );

  readonly usingTrakt = computed(() => this.provider() === 'trakt');

  setProvider(provider: LibraryProvider): void {
    if (provider !== 'mdblist' && provider !== 'trakt') return;
    localStorage.setItem(STORAGE_KEY, provider);
    this.selected.set(provider);
  }
}

function stored(): LibraryProvider {
  return localStorage.getItem(STORAGE_KEY) === 'trakt' ? 'trakt' : 'mdblist';
}
