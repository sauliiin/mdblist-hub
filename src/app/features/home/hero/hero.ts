import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { tmdbImg } from '../../../core/api.config';
import { MdblistService } from '../../../core/mdblist.service';
import { MdbItem, MdbList, TmdbDetail, TmdbLogo, toTmdbType } from '../../../core/models';
import { ThemePrefsService } from '../../../core/theme-prefs.service';
import { TmdbService } from '../../../core/tmdb.service';

interface Featured {
  item: MdbItem;
  backdrop: string | null;
  overview: string | null;
  genres: string[];
  vote: number | null;
  link: unknown[];
  /** Clearlogo art, when TMDB has one — see `pickLogo`. Only shown on Netflixy/Primefly. */
  logo: string | null;
}

/**
 * TMDB ranks `images.logos` by community vote already, but not by language —
 * an English (or language-less) logo reads better here than one in the
 * request's other fallback languages, so that goes first regardless of the
 * incoming order; `vote_average` breaks ties within each tier.
 */
function pickLogo(logos: TmdbLogo[] | undefined): string | null {
  if (!logos?.length) return null;

  const ranked = [...logos].sort((a, b) => {
    const tier = (logo: TmdbLogo) => (logo.iso_639_1 === 'en' ? 0 : logo.iso_639_1 === null ? 1 : 2);
    const byTier = tier(a) - tier(b);
    return byTier !== 0 ? byTier : b.vote_average - a.vote_average;
  });

  return tmdbImg(ranked[0].file_path, 'w500');
}

/** Lists that make a good hero pick, best first (matched on the raw mdblist name). */
const PREFERRED = ['trending movies', 'lastest movie releases', 'best ever'];

@Component({
  selector: 'app-hero',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero.html',
  styleUrl: './hero.scss',
})
export class Hero {
  private readonly mdblist = inject(MdblistService);
  private readonly tmdb = inject(TmdbService);
  protected readonly theme = inject(ThemePrefsService).themeKey;

  protected readonly featured = signal<Featured | null>(null);
  private lists: MdbList[] = [];

  constructor() {
    this.mdblist.lists().subscribe((lists) => {
      this.lists = lists;
      this.pick();
    });
  }

  /** Rolls a new spotlight title from one of the preferred lists. */
  protected pick(): void {
    const source = this.chooseList();
    if (!source) return;

    this.mdblist.listItems(source.id, 20).subscribe((items) => {
      const withPoster = items.filter((i) => i.poster);
      if (!withPoster.length) return;

      const item = withPoster[Math.floor(Math.random() * withPoster.length)];
      this.featured.set({
        item,
        backdrop: null,
        overview: null,
        genres: item.genre ?? [],
        vote: null,
        link: ['/title', toTmdbType(item.mediatype), item.id],
        logo: null,
      });

      this.tmdb.detail(item.mediatype, item.id).subscribe((detail) => this.enrich(item, detail));
    });
  }

  private enrich(item: MdbItem, detail: TmdbDetail | null): void {
    if (!detail || this.featured()?.item.id !== item.id) return;
    this.featured.update((current) =>
      current && {
        ...current,
        backdrop: tmdbImg(detail.backdrop_path, 'w1280'),
        overview: detail.overview,
        genres: detail.genres?.map((g) => g.name) ?? current.genres,
        vote: detail.vote_average ? Math.round(detail.vote_average * 10) : null,
        // Stored regardless of the active theme — it rides along in the same
        // `detail()` call for free, and the template is what decides whether
        // a Netflixy/Primefly hero actually draws it.
        logo: pickLogo(detail.images?.logos),
      },
    );
  }

  private chooseList(): MdbList | undefined {
    for (const needle of PREFERRED) {
      const match = this.lists.find((l) => l.name.toLowerCase() === needle);
      if (match) return match;
    }
    return this.lists[0];
  }
}
