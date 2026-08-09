import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, switchMap } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { noCache } from '../http-cache.interceptor';
import {
  InstalledAddon, PlayableStream, StreamQuery, StremioStream, StremioSubtitle, StremioType,
  SubtitleOption,
} from './models';
import { AddonsService } from './addons.service';
import { SubtitleSourcesService } from './subtitle-sources.service';
import {
  decodeSubtitle, languageLabel, languageRank, srtToVtt, toBcp47, unwrapSubtitle,
} from './subtitles';

/** Containers no desktop browser demuxes, however direct the link is. */
const UNPLAYABLE_CONTAINERS = /\.(mkv|avi|wmv|flv|mpg|mpeg|m2ts|ts|rmvb|ogm)(\?|$)/i;

@Injectable({ providedIn: 'root' })
export class StremioService {
  private readonly http = inject(HttpClient);
  private readonly addons = inject(AddonsService);
  private readonly subtitleSources = inject(SubtitleSourcesService);

  /**
   * Asks every installed addon that serves `stream` for this id, in parallel.
   * A failing addon contributes nothing rather than failing the page — with a
   * dozen installed, one being down is normal.
   */
  streams(type: StremioType, id: string): Observable<StreamQuery> {
    const providers = this.addons.streamProviders(type, id);
    if (!providers.length) return of({ streams: [], queried: 0, failed: 0 });

    return forkJoin(
      providers.map((addon) =>
        this.http
          .get<{ streams?: StremioStream[] }>(
            `${addon.base}/stream/${type}/${encodeURIComponent(id)}.json`,
            { context: noCache() },
          )
          .pipe(
            map((res) => ({
              streams: (res?.streams ?? []).map((s, i) => normalise(s, addon, i)),
              failed: false,
            })),
            catchError(() => of({ streams: [] as PlayableStream[], failed: true })),
          ),
      ),
    ).pipe(
      map((results) => ({
        streams: sortStreams(results.flatMap((r) => r.streams)),
        queried: providers.length,
        failed: results.filter((r) => r.failed).length,
      })),
    );
  }

  /** Installed addons plus the direct OpenSubtitles.com and Wyzie catalogs. */
  subtitles(type: StremioType, id: string): Observable<SubtitleOption[]> {
    const providers = this.addons.subtitleProviders(type, id);
    const addonSearches = providers.map((addon) =>
      this.http
        .get<{ subtitles?: StremioSubtitle[] }>(
          `${addon.base}/subtitles/${type}/${encodeURIComponent(id)}.json`,
          { context: noCache() },
        )
        .pipe(
          map((res) => (res?.subtitles ?? []).map((s, i) => toOption(s, addon, i))),
          catchError(() => of([] as SubtitleOption[])),
        ),
    );

    return forkJoin([
      ...addonSearches,
      this.subtitleSources.search(id),
    ]).pipe(map((lists) => sortSubtitles(dedupeSubtitles(lists.flat()))));
  }

  /**
   * Downloads a subtitle, converts it to WebVTT and returns a `blob:` URL for
   * `<track src>`. The caller owns the URL and must revoke it.
   *
   * The bytes go through [unwrapSubtitle] first: mirrors serve the same URL as
   * plain text, gzip or a zip, and only the leading bytes say which.
   */
  subtitleTrack(option: SubtitleOption): Observable<string> {
    return this.subtitleSources.resolveUrl(option).pipe(
      switchMap((url) => this.http.get(url, {
          responseType: 'arraybuffer',
          context: noCache(),
      })),
      switchMap((bytes) => unwrapSubtitle(bytes)),
      map((bytes) => {
        const vtt = srtToVtt(decodeSubtitle(bytes, option.encoding));
        return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      }),
    );
  }
}

function normalise(stream: StremioStream, addon: InstalledAddon, index: number): PlayableStream {
  const nameLines = lines(stream.name);
  const titleLines = lines(stream.title ?? stream.description);

  // Torrentio and friends put the release name on the first line of `title`
  // and the seeders/size/source line below it, with `name` holding the addon
  // tag plus the quality. Everything that is not the headline becomes detail.
  const headline =
    titleLines[0] || stream.behaviorHints?.filename || nameLines.join(' · ') || 'Stream';
  const detail = [...titleLines.slice(1), ...nameLines].join(' · ') || null;
  const label = `${stream.name ?? ''} ${stream.title ?? ''} ${stream.behaviorHints?.filename ?? ''}`;

  const base = {
    key: `${addon.base}#${index}`,
    addon: addon.manifest.name,
    title: headline,
    detail,
    filename: stream.behaviorHints?.filename ?? null,
    quality: quality(label),
    size: size(label, stream.behaviorHints?.videoSize),
  };

  if (stream.url) {
    // The Android container explicitly accepts cleartext streams. A regular
    // HTTPS browser page must still reject them as mixed content.
    const insecure =
      !Capacitor.isNativePlatform() &&
      stream.url.startsWith('http://') &&
      location.protocol === 'https:';
    return {
      ...base,
      url: insecure ? null : stream.url,
      externalUrl: stream.url,
      playable: !insecure,
      reason: insecure ? 'insecure' : null,
      warning: insecure ? null : urlWarning(stream),
    };
  }

  if (stream.infoHash) {
    return {
      ...base,
      url: null,
      externalUrl: magnet(stream.infoHash, headline),
      playable: false,
      reason: 'torrent',
      warning: null,
    };
  }

  const external = stream.ytId
    ? `https://www.youtube.com/watch?v=${stream.ytId}`
    : stream.externalUrl ?? null;

  return {
    ...base,
    url: null,
    externalUrl: external,
    playable: false,
    reason: 'external',
    warning: null,
  };
}

/** Attachable, but with a real chance of failing once the browser looks at it. */
function urlWarning(stream: StremioStream): string | null {
  if (UNPLAYABLE_CONTAINERS.test(stream.url ?? '')) {
    return 'Container que o navegador não abre (MKV e afins). Provavelmente só toca em player externo.';
  }
  if (/\.m3u8(\?|$)/i.test(stream.url ?? '')) {
    return 'Stream HLS — só toca nativamente no Safari.';
  }
  if (stream.behaviorHints?.notWebReady) {
    return 'O addon marcou este stream como não compatível com navegador.';
  }
  return null;
}

function magnet(infoHash: string, name: string): string {
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
  ];
  const params = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${params}`;
}

const QUALITY_ORDER = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];

function quality(label: string): string | null {
  if (/\b(2160p|4k|uhd)\b/i.test(label)) return '2160p';
  const match = label.match(/\b(1440|1080|720|480|360)p\b/i);
  return match ? `${match[1]}p` : null;
}

function size(label: string, bytes?: number): string | null {
  const match = label.match(/(\d+(?:[.,]\d+)?)\s*(GB|MB|GiB|MiB)/i);
  if (match) return `${match[1].replace(',', '.')} ${match[2].replace('i', '')}`;
  if (!bytes) return null;

  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Playable first, then sharpest, then biggest file — the usual pick order. */
function sortStreams(streams: PlayableStream[]): PlayableStream[] {
  return streams.sort((a, b) => {
    if (a.playable !== b.playable) return a.playable ? -1 : 1;
    if (!!a.warning !== !!b.warning) return a.warning ? 1 : -1;

    const rank = (s: PlayableStream) =>
      s.quality ? QUALITY_ORDER.indexOf(s.quality) : QUALITY_ORDER.length;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);

    return gigabytes(b.size) - gigabytes(a.size);
  });
}

function gigabytes(size: string | null): number {
  if (!size) return 0;
  const value = parseFloat(size);
  return size.toUpperCase().includes('GB') ? value : value / 1024;
}

function toOption(sub: StremioSubtitle, addon: InstalledAddon, index: number): SubtitleOption {
  return {
    key: `${addon.base}#${sub.id ?? index}`,
    addon: addon.manifest.name,
    label: languageLabel(sub.lang),
    lang: sub.lang ?? '',
    srclang: toBcp47(sub.lang ?? ''),
    url: sub.url,
    encoding: sub.SubEncoding ?? null,
    releaseHint: [sub.title, sub.release, sub.SubFileName]
      .find((hint) => !!hint?.trim()) ?? null,
    popularity: 0,
  };
}

/** OpenSubtitles mirrors hand back the same file under several ids. */
function dedupeSubtitles(subs: SubtitleOption[]): SubtitleOption[] {
  const seen = new Set<string>();
  return subs.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

function sortSubtitles(subs: SubtitleOption[]): SubtitleOption[] {
  return subs.sort(
    (a, b) => languageRank(a.lang) - languageRank(b.lang) || a.label.localeCompare(b.label, 'pt-BR'),
  );
}

function lines(value: string | null | undefined): string[] {
  return (value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
