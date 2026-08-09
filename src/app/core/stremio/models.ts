/**
 * Types for the Stremio addon protocol.
 *
 * An addon is just an HTTP host that answers JSON on a fixed set of paths:
 *
 *   {base}/manifest.json
 *   {base}/stream/{type}/{id}.json      → { streams: [...] }
 *   {base}/subtitles/{type}/{id}.json   → { subtitles: [...] }
 *
 * The official addon SDK replies with `Access-Control-Allow-Origin: *` — that
 * is what web.stremio.com relies on — so every call here runs straight from
 * the browser, like the other four APIs in `core/api.config.ts`.
 *
 * Reference: https://github.com/Stremio/stremio-addon-sdk/tree/master/docs
 */

/** The protocol's own vocabulary, alongside mdblist's `movie | show`. */
export type StremioType = 'movie' | 'series';

/** A resource is either a bare name or a name narrowed by type/id prefix. */
export type ManifestResource =
  | string
  | { name: string; types?: string[]; idPrefixes?: string[] };

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  background?: string;
  types?: string[];
  resources?: ManifestResource[];
  idPrefixes?: string[];
  catalogs?: { type: string; id: string; name?: string }[];
  behaviorHints?: {
    /** The addon has a configuration page at `{base}/configure`. */
    configurable?: boolean;
    /** It answers nothing useful until configured there. */
    configurationRequired?: boolean;
  };
}

/**
 * One playback option. Exactly one of `url` / `ytId` / `infoHash` /
 * `externalUrl` carries the source; the rest is presentation.
 */
export interface StremioStream {
  /** A direct HTTP(S) media URL — the only shape a browser can play. */
  url?: string;
  ytId?: string;
  /** A torrent. Unreachable from a browser; see `PlayableStream.reason`. */
  infoHash?: string;
  fileIdx?: number;
  /** A page to open elsewhere, not a media file. */
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: StremioSubtitle[];
  behaviorHints?: {
    /** The addon itself warns the stream needs a native player. */
    notWebReady?: boolean;
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
  };
}

export interface StremioSubtitle {
  id: string;
  url: string;
  /** ISO 639-2/B most of the time ("por", "eng"), but addons vary. */
  lang: string;
  SubEncoding?: string;
  /** Optional, non-standard release hints volunteered by some addons. */
  title?: string;
  release?: string;
  SubFileName?: string;
}

/**
 * What an import from a Stremio account actually did.
 *
 * A bare count hides the interesting half: an addon that the account has but
 * that never lands here is exactly the case worth reporting, and it needs a
 * reason attached to be actionable.
 */
export interface ImportReport {
  /** Entries the API returned. */
  received: number;
  /** Names of the addons that landed. */
  imported: string[];
  skipped: { name: string; url: string; reason: string }[];
  /**
   * Every entry the API answered with, untouched.
   *
   * This is the ground truth for "I added it in Stremio and it did not come":
   * if an addon is missing here, it never reached the account, and no amount
   * of fixing on this side would produce it.
   */
  entries: { name: string; url: string }[];
}

/** An addon the visitor added, kept in `localStorage`. */
export interface InstalledAddon {
  /** Transport URL with `/manifest.json` stripped, no trailing slash. */
  base: string;
  manifest: StremioManifest;
  addedAt: string;
}

// ------------------------------------------------------- view-model types

/** Why a stream cannot be handed to `<video>` at all. */
export type BlockedReason = 'torrent' | 'insecure' | 'external';

/** A stream normalised for the player's source list. */
export interface PlayableStream {
  key: string;
  /** Name of the addon that returned it. */
  addon: string;
  title: string;
  detail: string | null;
  /** Exact filename when the addon provides one; strongest release match hint. */
  filename: string | null;
  /** Set only when the browser can attempt to load it into `<video>`. */
  url: string | null;
  /** A link to hand to an external player, set whenever we have any URL. */
  externalUrl: string | null;
  playable: boolean;
  /** Set when `playable` is false. */
  reason: BlockedReason | null;
  /**
   * Set when the stream is attachable but likely to fail — an `.mkv` Chrome
   * cannot demux, or an addon that flagged `notWebReady`. Worth trying rather
   * than hiding, since the fallback is one click away.
   */
  warning: string | null;
  /** Parsed out of the label — "2160p", "1080p"… */
  quality: string | null;
  /** Parsed out of the label or `behaviorHints.videoSize`. */
  size: string | null;
}

/**
 * The outcome of asking every addon for one title.
 *
 * The counts are what let the player tell apart "no installed addon even
 * serves streams", "they were asked and had nothing", and "they were asked and
 * broke" — three very different things to be told when the list comes up empty.
 */
export interface StreamQuery {
  streams: PlayableStream[];
  /** Addons that advertise the resource for this type and id. */
  queried: number;
  /** Of those, how many failed outright. */
  failed: number;
}

/** A subtitle track offered for the current title. */
export interface SubtitleOption {
  key: string;
  addon: string;
  /** Human label, already resolved from the ISO code where we know it. */
  label: string;
  /** The addon's own code ("por", "pob"), kept for display. */
  lang: string;
  /** The same language as a tag `<track srclang>` accepts. */
  srclang: string;
  url: string;
  /** What the addon says the file is encoded in, when it says anything. */
  encoding: string | null;
  /** Release/file name used to match the subtitle to the stream being played. */
  releaseHint: string | null;
  /** Source download count, used only as a matching tiebreaker. */
  popularity: number;
}

/** Reads `resources` + `types` + `idPrefixes` to see if an addon can answer. */
export function serves(
  manifest: StremioManifest,
  resource: 'stream' | 'subtitles' | 'meta' | 'catalog',
  type: StremioType,
  id: string,
): boolean {
  const entry = (manifest.resources ?? []).find(
    (r) => (typeof r === 'string' ? r : r.name) === resource,
  );
  if (!entry) return false;

  // A narrowed entry overrides the manifest-wide lists; a bare string inherits
  // them. This is the precedence the SDK documents.
  const types = (typeof entry === 'string' ? undefined : entry.types) ?? manifest.types;
  if (types?.length && !types.includes(type)) return false;

  const prefixes =
    (typeof entry === 'string' ? undefined : entry.idPrefixes) ?? manifest.idPrefixes;
  if (prefixes?.length && !prefixes.some((p) => id.startsWith(p))) return false;

  return true;
}

/**
 * Reduces every shape an addon URL arrives in — the `stremio://` deep link
 * Stremio's own install buttons produce, a full `…/manifest.json`, or a bare
 * host — to the transport URL the protocol paths hang off.
 *
 * Throws on anything the URL parser rejects, which is the validation.
 */
export function normaliseAddonUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error('empty');

  if (raw.startsWith('stremio://')) raw = `https://${raw.slice('stremio://'.length)}`;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '')}`;
}

/** `movie` | `show` (mdblist) → `movie` | `series` (Stremio). */
export function toStremioType(type: 'movie' | 'show'): StremioType {
  return type === 'show' ? 'series' : 'movie';
}

/**
 * The id a stream is requested by: the bare IMDb id for a film, and
 * `tt0903747:1:1` — imdb:season:episode — for an episode.
 */
export function stremioId(
  imdbId: string,
  season?: number | null,
  episode?: number | null,
): string {
  return season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
}
