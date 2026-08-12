import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { GoogleAuthService } from '../../core/google-auth.service';
import { AddonsService } from '../../core/stremio/addons.service';
import { ImportReport, InstalledAddon, ManifestResource } from '../../core/stremio/models';
import { StremioAccountService } from '../../core/stremio/stremio-account.service';
import { AddonSyncService } from '../../core/sync/addon-sync.service';
import { PreferencesSyncService } from '../../core/sync/preferences-sync.service';

/** Addons worth pointing people at, with what each one is for. */
interface Suggestion {
  name: string;
  what: string;
  /** Set when the addon works as-is; absent when it must be configured first. */
  url?: string;
  /** Its own configuration page, where a configured URL is generated. */
  configure?: string;
  /** What the bare endpoint answers before configuration, when we checked. */
  unconfigured?: string;
}

const AIOSTREAMS_ELFHOSTED: Suggestion = {
  name: 'AIOStreams | ElfHosted',
  what:
    'Junta vários addons de fontes num só, deduplica e reordena os resultados. A URL do ' +
    'manifest é gerada por usuário na configuração.',
  configure: 'https://aiostreams.elfhosted.com/stremio/configure',
  unconfigured: 'só funciona pela URL gerada',
};

@Component({
  selector: 'app-addons',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './addons.html',
  styleUrl: './addons.scss',
})
export class Addons {
  private readonly service = inject(AddonsService);
  private readonly stremio = inject(StremioAccountService);
  private readonly cloud = inject(AddonSyncService);
  private readonly googleAuth = inject(GoogleAuthService);
  private readonly preferencesSync = inject(PreferencesSyncService);

  // ------------------------------------------------------ firebase sync
  protected readonly googleLinked = this.googleAuth.linked;
  protected readonly googleProfile = this.googleAuth.profile;
  protected readonly googleBusy = signal(false);
  protected readonly googleError = signal<string | null>(null);
  protected readonly syncOn = this.cloud.enabled;
  protected readonly syncBusy = this.cloud.busy;
  protected readonly syncFailure = this.cloud.error;
  protected readonly lastSync = this.cloud.lastSync;
  protected readonly pulled = signal<number | null>(null);

  protected readonly installed = this.service.installed;

  protected readonly url = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly added = signal<string | null>(null);
  /** Set when the addon installed fine but serves nothing the player uses. */
  protected readonly addedWarning = signal<string | null>(null);

  // --------------------------------------------------- Stremio account
  protected readonly account = this.stremio.account;
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly syncing = signal(false);
  protected readonly syncError = signal<string | null>(null);
  protected readonly report = signal<ImportReport | null>(null);

  /**
   * The two addons installed by default, offered right under the field
   * instead of buried in the suggestions further down — one for subtitles,
   * one for streams, which between them get a fresh install working.
   *
   * OpenSubtitles v3 has a fixed manifest that works for anyone, so it is a
   * real one-tap install. AIOStreams does not: its root answers with the
   * site's own PWA manifest, not an addon one — the per-user URL only exists
   * after configuring — so its button opens that page instead.
   */
  protected readonly quickAdd: Suggestion[] = [
    {
      name: 'OpenSubtitles v3',
      what: 'Legendas em dezenas de idiomas, já indexadas por IMDb ID.',
      url: 'https://opensubtitles-v3.strem.io/manifest.json',
    },
    AIOSTREAMS_ELFHOSTED,
  ];

  /**
   * Detailed recommendations. Each stream aggregator hands out a per-user URL
   * at its own configuration page, so none can be installed from a bare host.
   */
  protected readonly suggestions: Suggestion[] = [
    AIOSTREAMS_ELFHOSTED,
    {
      name: 'Torrentio',
      what:
        'Busca em indexadores públicos. Configure com sua chave de debrid (Real-Debrid, ' +
        'AllDebrid, Premiumize) para receber links HTTPS diretos — sem debrid ele devolve ' +
        'torrents, que o navegador não reproduz.',
      configure: 'https://torrentio.strem.fun/configure',
      unconfigured: 'sem configurar, devolve torrents',
    },
    {
      name: 'MediaFusion',
      what:
        'Agrega vários indexadores e tem catálogos próprios, com suporte a debrid. Aceita ' +
        'IDs de IMDb, TMDB e TVDB.',
      configure: 'https://mediafusion.elfhosted.com/configure',
      unconfigured: 'sem configurar, responde lista vazia',
    },
    {
      name: 'Comet',
      what:
        'Indexador rápido, pensado para debrid. Devolve link direto assim que o serviço ' +
        'tem o arquivo em cache.',
      configure: 'https://comet.elfhosted.com/configure',
      unconfigured: 'sem configurar, responde 403',
    },
  ];

  protected onUrl(event: Event): void {
    this.url.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.install(this.url());
  }

  protected install(url: string): void {
    if (!url.trim() || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    this.added.set(null);
    this.addedWarning.set(null);

    this.service.install(url).subscribe({
      next: (addon) => {
        this.busy.set(false);
        this.url.set('');
        this.added.set(addon.manifest.name);

        // Better to say so now than to let the player come up empty later.
        const usable = this.resources(addon).filter((r) => this.supported(r));
        this.addedWarning.set(
          usable.length
            ? null
            : `${addon.manifest.name} não declara fontes nem legendas, então o player não vai ` +
                'consultá-lo. Se ele exige configuração, instale pela URL gerada em /configure.',
        );
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected remove(addon: InstalledAddon): void {
    this.service.remove(addon.base);
  }

  // ------------------------------------------------------ firebase sync

  /**
   * The mdblist key's own login screen would be the natural place for this,
   * but it is guarded to redirect an already-signed-in visitor straight back
   * out — exactly the audience that needs to link Google to turn sync on. So
   * this lives here instead, on the one page that is both reachable while
   * signed in and already about "sync between devices".
   */
  protected connectGoogle(): void {
    if (this.googleBusy()) return;

    this.googleBusy.set(true);
    this.googleError.set(null);

    this.googleAuth.signIn().subscribe({
      next: () => {
        this.googleBusy.set(false);
        // Best-effort: brings this browser's font choice in line with
        // whatever was last synced, without blocking the button on it.
        this.preferencesSync.pull().subscribe({ error: () => undefined });
      },
      error: (err: Error) => {
        this.googleBusy.set(false);
        this.googleError.set(err.message);
      },
    });
  }

  protected disconnectGoogle(): void {
    if (this.syncOn()) this.cloud.disable();
    this.googleAuth.signOut();
  }

  protected toggleSync(): void {
    this.pulled.set(null);

    if (this.syncOn()) {
      this.cloud.disable();
      return;
    }
    this.cloud.enable().subscribe({ next: (n) => this.pulled.set(n), error: () => undefined });
  }

  protected pullNow(): void {
    this.pulled.set(null);
    this.cloud.pull().subscribe({ next: (n) => this.pulled.set(n), error: () => undefined });
  }

  protected pushNow(): void {
    this.pulled.set(null);
    this.cloud.push().subscribe({ error: () => undefined });
  }

  // --------------------------------------------------- Stremio account

  protected onEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
    this.syncError.set(null);
  }

  protected onPassword(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
    this.syncError.set(null);
  }

  protected signIn(event: Event): void {
    event.preventDefault();
    if (!this.email().trim() || !this.password() || this.syncing()) return;

    this.run(this.stremio.login(this.email(), this.password()), () => {
      // Nothing here needs the password again, so it does not linger in memory.
      this.password.set('');
    });
  }

  protected sync(): void {
    if (this.syncing()) return;
    this.run(this.stremio.sync());
  }

  protected signOut(): void {
    this.stremio.logout().subscribe();
    this.report.set(null);
    this.syncError.set(null);
  }

  private run(request: Observable<ImportReport>, onDone?: () => void): void {
    this.syncing.set(true);
    this.syncError.set(null);
    this.report.set(null);

    request.subscribe({
      next: (report) => {
        this.syncing.set(false);
        this.report.set(report);
        onDone?.();
      },
      error: (err: Error) => {
        this.syncing.set(false);
        this.syncError.set(err.message);
      },
    });
  }

  protected configureUrl(addon: InstalledAddon): string | null {
    return this.service.configureUrl(addon);
  }

  /** The resource names, flattened out of the two shapes a manifest allows. */
  protected resources(addon: InstalledAddon): string[] {
    return (addon.manifest.resources ?? []).map((r: ManifestResource) =>
      typeof r === 'string' ? r : r.name,
    );
  }

  /** Only `stream` and `subtitles` are wired to the player today. */
  protected supported(resource: string): boolean {
    return resource === 'stream' || resource === 'subtitles';
  }

  /** The host, which is what actually identifies an addon at a glance. */
  protected host(addon: InstalledAddon): string {
    try {
      return new URL(addon.base).host;
    } catch {
      return addon.base;
    }
  }
}
