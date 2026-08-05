import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { AddonsService } from '../../core/stremio/addons.service';
import { InstalledAddon, ManifestResource } from '../../core/stremio/models';
import { StremioAccountService } from '../../core/stremio/stremio-account.service';

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

@Component({
  selector: 'app-addons',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './addons.html',
  styleUrl: './addons.scss',
})
export class Addons {
  private readonly service = inject(AddonsService);
  private readonly stremio = inject(StremioAccountService);

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
  protected readonly synced = signal<number | null>(null);

  /**
   * All four source addons hand out a per-user URL at their own configuration
   * page, so none of them can be installed from a bare host here — which is why
   * only the subtitle addon gets a one-click button.
   */
  protected readonly suggestions: Suggestion[] = [
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
    {
      name: 'AIOStreams',
      what:
        'Junta vários addons num só, deduplica e reordena os resultados. A URL do manifest ' +
        'é gerada por usuário na configuração — o endereço base do site não é um addon, é a ' +
        'própria página dele.',
      configure: 'https://aiostreams.elfhosted.com/configure',
      unconfigured: 'só funciona pela URL gerada',
    },
    {
      name: 'OpenSubtitles v3',
      what: 'Legendas em dezenas de idiomas, já indexadas por IMDb ID.',
      url: 'https://opensubtitles-v3.strem.io/manifest.json',
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
    this.synced.set(null);
    this.syncError.set(null);
  }

  private run(request: Observable<number>, onDone?: () => void): void {
    this.syncing.set(true);
    this.syncError.set(null);
    this.synced.set(null);

    request.subscribe({
      next: (count) => {
        this.syncing.set(false);
        this.synced.set(count);
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
