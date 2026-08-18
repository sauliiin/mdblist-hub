import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { map, of, switchMap } from 'rxjs';
import { tmdbImg } from '../../../core/api.config';
import { AuthService } from '../../../core/auth.service';
import { activeLocale, I18nPipe } from '../../../core/i18n.service';
import { LibraryService } from '../../../core/library.service';
import { MediaDetail, TmdbEpisode, toTmdbType } from '../../../core/models';
import { TmdbService } from '../../../core/tmdb.service';
import { ScrollTrack } from '../../../ui/scroll-track/scroll-track';

/**
 * A show's episodes, one season at a time — the same row the TV and phone
 * apps put under the synopsis, with the two things that make it worth having
 * there: when each episode aired, and which ones the account has already
 * watched.
 *
 * The watched set comes from `LibraryService`, so it is whatever the selected
 * library provider knows — mdblist's `sync/watched` episodes, or Trakt's
 * per-season watched history.
 */
@Component({
  selector: 'app-episode-row',
  imports: [I18nPipe, RouterLink, ScrollTrack],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './episode-row.html',
  styleUrl: './episode-row.scss',
})
export class EpisodeRow {
  private readonly tmdb = inject(TmdbService);
  private readonly library = inject(LibraryService);
  private readonly auth = inject(AuthService);

  readonly show = input.required<MediaDetail>();

  /** Season on screen; the first one TMDB lists until someone picks another. */
  private readonly picked = signal<number | null>(null);

  protected readonly seasons = computed(() => this.show().seasonList);

  protected readonly season = computed(
    () => this.picked() ?? this.seasons()[0]?.season_number ?? 1,
  );

  /**
   * Whether clicking an episode can lead anywhere: the player is keyed by the
   * IMDb id the stream addons use, and an anonymous shared-key session gets no
   * player at all — see `AuthService.canPlay`.
   */
  protected readonly playable = computed(() => !!this.show().imdbId && this.auth.canPlay());

  /**
   * The chosen season's episodes.
   *
   * The show record the page already read carries season *summaries* only —
   * counts, posters, an air date for the season as a whole — so the episodes
   * themselves are one more call, the same `/tv/{id}/season/{n}` the player's
   * picker is built from.
   */
  protected readonly episodes = toSignal(
    toObservable(computed(() => ({ tmdbId: this.show().tmdbId, season: this.season() }))).pipe(
      switchMap(({ tmdbId, season }) => this.tmdb.season(tmdbId, season)),
      map((season) => season?.episodes ?? []),
    ),
    { initialValue: [] as TmdbEpisode[] },
  );

  /** "4/10" for the season on screen, or null while nothing is watched yet. */
  protected readonly progress = computed(() => {
    const episodes = this.episodes();
    if (!episodes.length) return null;
    const watched = episodes.filter((episode) => this.isWatched(episode)).length;
    return watched ? `${watched}/${episodes.length}` : null;
  });

  protected readonly watchLink = computed(() => ['/watch', toTmdbType(this.show().type), this.show().tmdbId]);

  protected pick(season: number): void {
    this.picked.set(season);
  }

  protected still(episode: TmdbEpisode): string | null {
    return tmdbImg(episode.still_path, 'w300');
  }

  protected isWatched(episode: TmdbEpisode): boolean {
    return this.library.isEpisodeWatched(
      this.show().tmdbId,
      episode.season_number,
      episode.episode_number,
    );
  }

  protected airDate(episode: TmdbEpisode): string | null {
    return formatAirDate(episode.air_date);
  }

  /** Dated in the future — the case where the date is the whole point. */
  protected isUpcoming(episode: TmdbEpisode): boolean {
    const date = parseAirDate(episode.air_date);
    return !!date && date.getTime() > Date.now();
  }

  protected query(episode: TmdbEpisode): Record<string, number> {
    return { season: episode.season_number, episode: episode.episode_number };
  }
}

/**
 * TMDB's `air_date` ("2026-12-18") as a short weekday plus date, in whichever
 * language the interface is in — "sex., 18/12/2026" or "Fri, Dec 18, 2026",
 * the two formats the native app prints for the same field.
 */
function formatAirDate(airDate: string | null): string | null {
  const date = parseAirDate(airDate);
  if (!date) return null;

  const locale = activeLocale();
  return date.toLocaleDateString(
    locale,
    locale.startsWith('pt')
      ? { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
  );
}

/**
 * Built from the parts rather than parsed whole: `new Date('2026-12-18')` is
 * midnight *UTC*, which prints as the day before anywhere west of Greenwich —
 * every Brazilian visitor would see each episode air a day early.
 */
function parseAirDate(airDate: string | null): Date | null {
  const parts = airDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return null;
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}
