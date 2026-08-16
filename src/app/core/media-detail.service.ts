import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of, switchMap } from 'rxjs';
import { tmdbImg } from './api.config';
import { translate } from './i18n.service';
import { MdblistService } from './mdblist.service';
import {
  MdbInfo, MdbReview, MediaDetail, MediaType, OmdbResponse, Review, TmdbCastMember,
  TmdbCrewMember, TmdbDetail, TmdbReview,
} from './models';
import { OmdbService } from './omdb.service';
import { badgesFromOmdb, toBadges } from './ratings';
import { TmdbService } from './tmdb.service';

@Injectable({ providedIn: 'root' })
export class MediaDetailService {
  private readonly tmdb = inject(TmdbService);
  private readonly mdblist = inject(MdblistService);
  private readonly omdb = inject(OmdbService);

  /**
   * Assembles the detail view. TMDB comes first because it resolves the IMDb
   * id that OMDb is keyed by; everything after runs in parallel and degrades
   * to `null` rather than failing the page.
   */
  load(type: MediaType, tmdbId: number): Observable<MediaDetail | null> {
    return this.tmdb.detail(type, tmdbId).pipe(
      switchMap((tmdb) => {
        if (!tmdb) return of(null);
        const imdbId = tmdb.external_ids?.imdb_id ?? null;

        return forkJoin({
          info: this.mdblist.info(type, tmdbId),
          omdb: imdbId ? this.omdb.byImdb(imdbId) : of({ data: null, error: null }),
          tmdbReviews: this.tmdb.reviews(type, tmdbId),
        }).pipe(
          map(({ info, omdb, tmdbReviews }) =>
            assemble(type, tmdbId, imdbId, tmdb, info, omdb.data, tmdbReviews),
          ),
        );
      }),
    );
  }
}

function assemble(
  type: MediaType,
  tmdbId: number,
  imdbId: string | null,
  tmdb: TmdbDetail,
  info: MdbInfo | null,
  omdb: OmdbResponse | null,
  tmdbReviews: TmdbReview[],
): MediaDetail {
  const credits = tmdb.credits ?? tmdb.aggregate_credits;
  const crew = credits?.crew ?? [];

  // Reviews are merged from both sources rather than picked between, the way
  // embuary does it: TMDB first, then everything mdblist mirrors that TMDB did
  // not already provide — including the Trakt comments (`provider_id: 1`),
  // which is how Trakt reviews reach the page without calling Trakt directly.
  const reviews = dedupe([
    ...tmdbReviews.map(fromTmdb),
    ...(info?.reviews ?? []).map(fromMdblist),
  ]);

  let ratings = toBadges(info?.ratings);
  if (!ratings.length) ratings = badgesFromOmdb(omdb);

  const trailer = tmdb.videos?.results?.find(
    (v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official,
  ) ?? tmdb.videos?.results?.find((v) => v.site === 'YouTube');

  const date = tmdb.release_date || tmdb.first_air_date || info?.released || null;

  return {
    type,
    tmdbId,
    imdbId,
    title: tmdb.title || tmdb.name || info?.title || translate('Untitled'),
    originalTitle: tmdb.original_title || tmdb.original_name || null,
    tagline: tmdb.tagline || info?.tagline || null,
    overview: tmdb.overview || info?.description || omdb?.Plot || null,
    // `w1280` e não `original`: um backdrop original chega a 3–8 MB e não há
    // tela no app que pinte mais que 1280px dele — o hero já usa w1280.
    backdrop: tmdbImg(tmdb.backdrop_path, 'w1280'),
    poster: tmdbImg(tmdb.poster_path, 'w500'),
    year: date ? Number(date.slice(0, 4)) : info?.year ?? null,
    releaseDate: date,
    runtime: tmdb.runtime ?? tmdb.episode_run_time?.[0] ?? info?.runtime ?? null,
    seasons: tmdb.number_of_seasons ?? null,
    episodes: tmdb.number_of_episodes ?? null,
    status: tmdb.status ?? null,
    genres: tmdb.genres?.map((g) => g.name) ?? [],
    cast: (credits?.cast ?? []).slice(0, 24),
    directors: names(crew, ['Director', 'Series Director']),
    writers: names(crew, ['Screenplay', 'Writer', 'Story']),
    companies: tmdb.production_companies?.map((c) => c.name).slice(0, 4) ?? [],
    trailerKey: trailer?.key ?? null,
    homepage: tmdb.homepage || null,
    ratings,
    reviews,
    recommendations: (tmdb.recommendations?.results ?? []).slice(0, 12),
    omdb,
    budget: tmdb.budget || info?.budget || null,
    revenue: tmdb.revenue || info?.revenue || null,
  };
}

/** Crew entries differ between `credits` (job) and `aggregate_credits` (jobs[]). */
function names(crew: TmdbCrewMember[], jobs: string[]): string[] {
  const matched = crew.filter(
    (c) => (c.job && jobs.includes(c.job)) || c.jobs?.some((j) => jobs.includes(j.job)),
  );
  return [...new Set(matched.map((c) => c.name))].slice(0, 3);
}

/**
 * mdblist relays the same reviews the other two APIs serve, so the merged list
 * is deduplicated on author + the opening of the content.
 */
function dedupe(reviews: Review[]): Review[] {
  const seen = new Set<string>();
  const unique: Review[] = [];

  for (const review of reviews) {
    const key = `${normalise(review.author)}|${normalise(review.content).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(review);
  }

  return unique;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function fromMdblist(r: MdbReview): Review {
  // provider_id 1 = Trakt, 2 = TMDB.
  const source = r.provider_id === 2 ? 'tmdb' : 'trakt';
  return {
    id: `mdblist-${source}-${normalise(r.author)}-${r.updated_at}`,
    author: r.author || translate('Anonymous'),
    avatar: null,
    content: stripMarkup(r.content),
    rating: r.rating,
    createdAt: r.updated_at,
    likes: null,
    spoiler: false,
    source,
    via: 'mdblist',
    url: null,
  };
}

function fromTmdb(r: TmdbReview): Review {
  return {
    id: `tmdb-${r.id}`,
    author: r.author_details?.name || r.author || translate('TMDB user'),
    avatar: avatarUrl(r.author_details?.avatar_path),
    content: stripMarkup(r.content),
    rating: r.author_details?.rating ?? null,
    createdAt: r.created_at,
    likes: null,
    spoiler: false,
    source: 'tmdb',
    via: null,
    url: r.url,
  };
}

/**
 * TMDB reviews are user-written and arrive with raw HTML and BBCode-ish
 * markup. The template renders them as text, so the tags are stripped here
 * (keeping link text) instead of being shown literally.
 */
function stripMarkup(content: string): string {
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** TMDB avatars are sometimes a Gravatar URL smuggled inside the path. */
function avatarUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('/https')) return path.slice(1);
  return tmdbImg(path, 'w185');
}

export function castCharacter(member: TmdbCastMember): string {
  return member.character || member.roles?.[0]?.character || '';
}
