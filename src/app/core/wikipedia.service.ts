import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, switchMap } from 'rxjs';
import { wikipediaLanguage } from './i18n.service';

/**
 * Wikipedia biographies, following the same route as
 * `script.embuaryEnhanced.info/resources/lib/wikipedia.py`:
 *
 *   TMDB person id → Wikidata Q-id (`haswbstatement:P4985=<id>`)
 *                  → entity sitelinks + claims
 *                  → article intro via `prop=extracts&exintro`
 *
 * Every Wikimedia call carries `origin=*`, which is what enables anonymous
 * CORS from the browser.
 */
const WIKIDATA = 'https://www.wikidata.org/w/api.php';

const PROP = {
  tmdbPerson: 'P4985',
  imdb: 'P345',
  birth: 'P569',
  death: 'P570',
  birthplace: 'P19',
} as const;

/**
 * Below this the pt article is treated as a stub and English is preferred.
 * embuary uses 600, but most actor articles in pt sit between 200 and 400
 * characters, which sent nearly every biography to English on a site that is
 * otherwise in Portuguese. 200 keeps real paragraphs and still skips stubs.
 */
const MIN_BIO_CHARS = 200;

export interface WikiBio {
  biography: string;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  articleUrl: string | null;
  /** Language the text actually came from. */
  lang: string | null;
}

const EMPTY: WikiBio = {
  biography: '',
  birthday: null,
  deathday: null,
  placeOfBirth: null,
  articleUrl: null,
  lang: null,
};

@Injectable({ providedIn: 'root' })
export class WikipediaService {
  private readonly http = inject(HttpClient);

  /** Biography and life facts for a person, empty when Wikipedia has none. */
  person(tmdbPersonId: number, imdbId: string | null): Observable<WikiBio> {
    return this.findQid(PROP.tmdbPerson, String(tmdbPersonId)).pipe(
      switchMap((qid) =>
        qid ? of(qid) : imdbId ? this.findQid(PROP.imdb, imdbId) : of(null),
      ),
      switchMap((qid) => (qid ? this.fromEntity(qid) : of(EMPTY))),
      catchError(() => of(EMPTY)),
    );
  }

  /** Finds the Wikidata item whose property `prop` equals `value`. */
  private findQid(prop: string, value: string): Observable<string | null> {
    return this.http
      .get<WikidataSearch>(WIKIDATA, {
        params: {
          action: 'query',
          format: 'json',
          list: 'search',
          srsearch: `haswbstatement:${prop}=${value}`,
          srlimit: 1,
          origin: '*',
        },
      })
      .pipe(
        map((res) => res?.query?.search?.[0]?.title ?? null),
        catchError(() => of(null)),
      );
  }

  private fromEntity(qid: string): Observable<WikiBio> {
    const lang = wikipediaLanguage();
    return this.http
      .get<WikidataEntities>(WIKIDATA, {
        params: {
          action: 'wbgetentities',
          format: 'json',
          ids: qid,
          props: 'sitelinks|claims',
          origin: '*',
        },
      })
      .pipe(
        switchMap((res) => {
          const entity = res?.entities?.[qid];
          if (!entity) return of(EMPTY);

          const localTitle = entity.sitelinks?.[`${lang}wiki`]?.title ?? null;
          const enTitle = entity.sitelinks?.['enwiki']?.title ?? null;
          const facts = {
            birthday: claimTime(entity, PROP.birth),
            deathday: claimTime(entity, PROP.death),
          };
          const placeQid = claimEntityId(entity, PROP.birthplace);

          return this.bestIntro(localTitle, enTitle, lang).pipe(
            switchMap((intro) =>
              this.label(placeQid, lang).pipe(
                map((placeOfBirth) => ({
                  ...facts,
                  placeOfBirth,
                  biography: intro.text,
                  lang: intro.lang,
                  articleUrl: intro.title
                    ? `https://${intro.lang}.wikipedia.org/wiki/${encodeURIComponent(intro.title.replace(/ /g, '_'))}`
                    : null,
                })),
              ),
            ),
          );
        }),
        catchError(() => of(EMPTY)),
      );
  }

  /**
   * Intro in the preferred language; if that article is a stub, the English
   * one is used when it is longer.
   */
  private bestIntro(
    localTitle: string | null,
    enTitle: string | null,
    lang: string,
  ): Observable<{ text: string; lang: string | null; title: string | null }> {
    if (!localTitle && !enTitle) return of({ text: '', lang: null, title: null });

    const primaryTitle = localTitle ?? enTitle!;
    const primaryLang = localTitle ? lang : 'en';

    return this.intro(primaryTitle, primaryLang).pipe(
      switchMap((text) => {
        const needsFallback = primaryLang !== 'en' && text.length < MIN_BIO_CHARS && enTitle;
        if (!needsFallback) return of({ text, lang: primaryLang, title: primaryTitle });

        return this.intro(enTitle!, 'en').pipe(
          map((enText) =>
            enText.length > text.length
              ? { text: enText, lang: 'en', title: enTitle! }
              : { text, lang: primaryLang, title: primaryTitle },
          ),
        );
      }),
    );
  }

  /** Plain-text lead section of an article. */
  private intro(title: string, lang: string): Observable<string> {
    return this.http
      .get<WikipediaExtract>(`https://${lang}.wikipedia.org/w/api.php`, {
        params: {
          action: 'query',
          format: 'json',
          prop: 'extracts',
          explaintext: 1,
          exintro: 1,
          redirects: 1,
          titles: title,
          origin: '*',
        },
      })
      .pipe(
        map((res) => {
          const pages = Object.values(res?.query?.pages ?? {});
          return clean(pages.find((p) => p.extract)?.extract ?? '');
        }),
        catchError(() => of('')),
      );
  }

  /** Human-readable label of a Wikidata item (used for the birthplace). */
  private label(qid: string | null, lang: string): Observable<string | null> {
    if (!qid) return of(null);

    return this.http
      .get<WikidataEntities>(WIKIDATA, {
        params: {
          action: 'wbgetentities',
          format: 'json',
          ids: qid,
          props: 'labels',
          languages: lang === 'en' ? 'en' : `${lang}|en`,
          origin: '*',
        },
      })
      .pipe(
        map((res) => {
          const labels = res?.entities?.[qid]?.labels;
          return labels?.[lang]?.value ?? labels?.['en']?.value ?? null;
        }),
        catchError(() => of(null)),
      );
  }
}

// ------------------------------------------------------------ wire formats

interface WikidataSearch {
  query?: { search?: { title: string }[] };
}

interface WikidataEntity {
  sitelinks?: Record<string, { title: string }>;
  labels?: Record<string, { value: string }>;
  claims?: Record<string, WikidataClaim[]>;
}

interface WikidataClaim {
  mainsnak?: {
    datavalue?: { value?: { time?: string; id?: string } };
  };
}

interface WikidataEntities {
  entities?: Record<string, WikidataEntity>;
}

interface WikipediaExtract {
  query?: { pages?: Record<string, { extract?: string }> };
}

/**
 * Article intros sometimes end with leftovers from stripped infoboxes — a line
 * holding nothing but a period, for instance.
 */
function clean(extract: string): string {
  return extract
    .split('\n')
    .filter((line) => /\p{L}|\p{N}/u.test(line))
    .join('\n')
    .trim();
}

/**
 * Wikidata times look like `+1937-06-01T00:00:00Z`. Values less precise than a
 * day arrive with zeroed components, so only the known part is kept.
 */
function claimTime(entity: WikidataEntity, prop: string): string | null {
  const time = entity.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.time;
  if (!time) return null;

  const match = /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(time);
  if (!match) return null;

  const [, year, month, day] = match;
  if (month === '00') return year;
  if (day === '00') return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function claimEntityId(entity: WikidataEntity, prop: string): string | null {
  return entity.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.id ?? null;
}
