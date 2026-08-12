import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { tmdbImg } from '../../../core/api.config';
import { formatYear, toTmdbType } from '../../../core/models';
import { ResumeItem } from '../../../core/scrobble/models';
import { ScrobbleService } from '../../../core/scrobble/scrobble.service';
import { TmdbService } from '../../../core/tmdb.service';
import { TvService } from '../../../core/tv/tv.service';

/** A resume entry with the backdrop TMDB has for it — landscape, not the poster. */
interface ResumeCard extends ResumeItem {
  backdrop: string | null;
}

/**
 * "Continuar assistindo", straight out of `GET /sync/playback`.
 *
 * The sessions are mdblist's, not this app's, so a film paused in the Stremio
 * app — or on another device — shows up here too.
 */
@Component({
  selector: 'app-continue-watching',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './continue-watching.html',
  styleUrl: './continue-watching.scss',
})
export class ContinueWatching implements OnInit {
  private readonly scrobble = inject(ScrobbleService);
  private readonly tmdb = inject(TmdbService);
  private readonly tv = inject(TvService);

  protected readonly rows = signal<ResumeCard[]>([]);
  protected readonly loading = signal(true);
  protected readonly formatYear = formatYear;

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.scrobble.sessions().subscribe((items) => {
      // Show the row immediately; backdrops fill in as TMDB answers.
      this.rows.set(items.map((item) => ({ ...item, backdrop: null })));
      this.loading.set(false);

      for (const item of items) {
        if (!item.tmdbId) continue;
        this.tmdb.detail(item.type, item.tmdbId).subscribe((detail) => {
          if (!detail) return;
          // Backdrop sizes are a separate scale from posters — `w185`/`w342`
          // are poster-only and 404 against a backdrop path.
          const size = this.tv.isTv() ? 'w300' : 'w780';
          const date = detail.release_date || detail.first_air_date || '';
          const year = Number(date.slice(0, 4)) || null;
          this.rows.update((list) =>
            list.map((row) =>
              row.key === item.key
                ? {
                    ...row,
                    backdrop: tmdbImg(detail.backdrop_path, size),
                    year: row.year ?? year,
                  }
                : row,
            ),
          );
        });
      }
    });
  }

  /** Straight into the player, at the episode the session was left on. */
  protected link(item: ResumeCard): unknown[] {
    return ['/watch', toTmdbType(item.type), item.tmdbId];
  }

  protected query(item: ResumeCard): Record<string, number> {
    return item.season && item.episode
      ? { season: item.season, episode: item.episode }
      : {};
  }

  /** Removes the entry from mdblist's continue-watching, and from the row. */
  protected dismiss(item: ResumeCard, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    this.rows.update((list) => list.filter((row) => row.key !== item.key));
    this.scrobble
      .clear({
        type: item.type,
        imdbId: item.imdbId,
        tmdbId: item.tmdbId ?? 0,
        season: item.season,
        episode: item.episode,
      })
      .subscribe();
  }
}
