import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';
import { RawAddonCatalog } from '../models';
import { translate } from '../i18n.service';
import {
  ImportReport, InstalledAddon, StremioManifest, StremioType, normaliseAddonUrl, serves,
} from './models';

const STORAGE_KEY = 'mdblist-hub.addons';

/**
 * The addons the visitor has installed.
 *
 * Nothing ships in the bundle: the app is a client for the protocol, and every
 * addon URL is pasted by whoever is using it — the same model as Stremio, and
 * the same one `AuthService` already uses for the mdblist key.
 */
@Injectable({ providedIn: 'root' })
export class AddonsService {
  private readonly http = inject(HttpClient);

  private readonly addons = signal<InstalledAddon[]>(stored());

  readonly installed = this.addons.asReadonly();
  readonly count = computed(() => this.addons().length);

  /**
   * Every catalog every installed addon declares, flattened — the raw
   * pointers `Home` turns into rows. Mirrors the native apps' own
   * `AddonsRepository.observeCatalogs()` (minus its own decoration, applied
   * here by `applyPrefs()` in `Home.curated()` instead).
   */
  readonly catalogs = computed<RawAddonCatalog[]>(() =>
    this.addons().flatMap((addon) =>
      (addon.manifest.catalogs ?? [])
        .filter((catalog) => catalog.id && catalog.type)
        .map((catalog): RawAddonCatalog => ({
          addonBase: addon.base,
          addonId: addon.manifest.id,
          id: catalog.id,
          type: catalog.type,
          originalName: catalog.name || addon.manifest.name,
        })),
    ),
  );

  /** Addons that advertise `stream` for this type and id shape. */
  streamProviders(type: StremioType, id: string): InstalledAddon[] {
    return this.addons().filter((a) => serves(a.manifest, 'stream', type, id));
  }

  /** Addons that advertise `subtitles` for this type and id shape. */
  subtitleProviders(type: StremioType, id: string): InstalledAddon[] {
    return this.addons().filter((a) => serves(a.manifest, 'subtitles', type, id));
  }

  /**
   * Fetches the manifest at `url` and keeps it. Re-installing an addon that is
   * already there refreshes its manifest instead of duplicating it, which is
   * how a re-configured addon (a new debrid key, say) gets updated.
   */
  install(url: string): Observable<InstalledAddon> {
    let base: string;
    try {
      base = normaliseAddonUrl(url);
    } catch {
      return throwError(() => new Error(translate('Invalid URL. Paste the address of the addon manifest.json.')));
    }

    return this.http.get<StremioManifest>(`${base}/manifest.json`).pipe(
      catchError(() =>
        throwError(
          () =>
            new Error(translate('Could not read the manifest. Check the URL and make sure the addon allows browser CORS requests.')),
        ),
      ),
      map((manifest) => {
        // A host's own PWA manifest has `name` but no `id`, and AIOStreams
        // serves exactly that at its root — so this is the error people hit
        // when they paste the site instead of the URL it generated for them.
        if (!manifest?.id || !manifest?.name) {
          throw new Error(translate('The address responded, but it is not a Stremio addon manifest. Many addons generate a URL for each user on their configuration page — paste that URL here, not the website address.'));
        }

        const addon: InstalledAddon = { base, manifest, addedAt: new Date().toISOString() };
        this.addons.update((list) => [...list.filter((a) => a.base !== base), addon]);
        this.persist();
        return addon;
      }),
    );
  }

  /**
   * Merges a Stremio account's addon collection in, and answers how many
   * entries landed.
   *
   * The collection already carries each manifest, so nothing is re-fetched —
   * which also means an addon whose host is momentarily down still imports.
   * Merging rather than replacing keeps addons added by hand on this browser.
   */
  importCollection(
    entries: { transportUrl?: string; manifest?: StremioManifest }[],
  ): ImportReport {
    const imported: InstalledAddon[] = [];
    const skipped: ImportReport['skipped'] = [];

    for (const entry of entries) {
      const url = entry?.transportUrl ?? '';
      const name = entry?.manifest?.name || url || translate('unnamed addon');

      if (!url) {
        skipped.push({ name, url, reason: translate('the account did not save this addon URL') });
        continue;
      }
      if (!entry?.manifest?.id) {
        skipped.push({ name, url, reason: translate('the manifest had no ID') });
        continue;
      }

      try {
        imported.push({
          base: normaliseAddonUrl(url),
          manifest: entry.manifest,
          addedAt: new Date().toISOString(),
        });
      } catch {
        skipped.push({ name, url, reason: translate('URL could not be parsed') });
      }
    }

    const bases = new Set(imported.map((a) => a.base));
    this.addons.update((list) => [...list.filter((a) => !bases.has(a.base)), ...imported]);
    this.persist();

    return {
      received: entries.length,
      imported: imported.map((a) => a.manifest.name),
      skipped,
      entries: entries.map((e) => ({
        name: e?.manifest?.name || translate('(unnamed)'),
        url: e?.transportUrl || translate('(no URL)'),
      })),
    };
  }

  /**
   * Folds a list of already-built addons in, answering how many were new to
   * this browser. Backs the Firebase pull, where the entries were written by
   * this same app and need no re-validation.
   */
  merge(incoming: InstalledAddon[]): number {
    const valid = incoming.filter((a) => a?.base && a?.manifest?.id);
    const known = new Set(this.addons().map((a) => a.base));
    const fresh = valid.filter((a) => !known.has(a.base)).length;

    const bases = new Set(valid.map((a) => a.base));
    this.addons.update((list) => [...list.filter((a) => !bases.has(a.base)), ...valid]);
    this.persist();

    return fresh;
  }

  /**
   * Makes the list exactly `next`. Backs the "Baixar" button, which is what
   * lets a removal made on another device actually land here — a merge can
   * only ever add, so on its own it would resurrect whatever was deleted.
   */
  replaceAll(next: InstalledAddon[]): void {
    this.addons.set(next.filter((a) => a?.base && a?.manifest?.id));
    this.persist();
  }

  remove(base: string): void {
    this.addons.update((list) => list.filter((a) => a.base !== base));
    this.persist();
  }

  /** Where an addon's own configuration page lives, when it has one. */
  configureUrl(addon: InstalledAddon): string | null {
    return addon.manifest.behaviorHints?.configurable ? `${addon.base}/configure` : null;
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.addons()));
  }
}

function stored(): InstalledAddon[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((a) => a?.base && a?.manifest) : [];
  } catch {
    return [];
  }
}
