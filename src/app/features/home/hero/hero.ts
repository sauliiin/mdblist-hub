import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { tmdbImg } from '../../../core/api.config';
import { MdblistService } from '../../../core/mdblist.service';
import { MdbItem, MdbList, TmdbDetail, toTmdbType } from '../../../core/models';
import { TmdbService } from '../../../core/tmdb.service';

interface Featured {
  item: MdbItem;
  backdrop: string | null;
  overview: string | null;
  genres: string[];
  vote: number | null;
  link: unknown[];
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
      },
    );
  }

  private chooseList(): MdbList | undefined {
    for (const needle of PREFERRED) {
      const match = this.lists.find(
        (l) => (l.originalName ?? l.name).toLowerCase() === needle,
      );
      if (match) return match;
    }
    return this.lists[0];
  }
}
