import { LRUCache } from 'lru-cache';
import { HttpFailure, upstream } from '../../shared/http.js';
import type { MediaType } from '../../shared/params.js';

type Json = Record<string, unknown>;

export function record(value: unknown): value is Json {
  return typeof value === 'object' && value !== null;
}

export const invalid = () => new HttpFailure(502, 'Respuesta inválida de TMDB');
export const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const textOrNull = (value: unknown) => typeof value === 'string' && value ? value : null;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;

export type Summary = {
  id: number;
  media_type: MediaType;
  title: string;
  poster_path: string | null;
  overview: string;
  release_date: string | null;
  vote_average: number | null;
  genre_ids: number[];
};

/** Normaliza películas y series de listados de TMDB. Devuelve null para personas. */
export function summary(item: unknown, fallback?: MediaType): Summary | null {
  if (!record(item)) throw invalid();
  const type = item.media_type ?? fallback;
  if (type === 'person') return null;
  const title = type === 'movie' ? item.title : item.name;
  if ((type !== 'movie' && type !== 'tv') || typeof title !== 'string' || !positiveId(item.id)) throw invalid();
  return {
    id: item.id, media_type: type, title,
    poster_path: textOrNull(item.poster_path),
    overview: typeof item.overview === 'string' ? item.overview : '',
    release_date: textOrNull(type === 'movie' ? item.release_date : item.first_air_date),
    vote_average: typeof item.vote_average === 'number' ? item.vote_average : null,
    genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids.filter(positiveId) : []
  };
}

/** TMDB no permite consultar más allá de la página 500. */
export function paged(raw: unknown, fallback?: MediaType) {
  if (!record(raw) || !Array.isArray(raw.results) || !positiveId(raw.page)) throw invalid();
  return {
    page: raw.page,
    total_pages: Math.min(count(raw.total_pages), 500),
    total_results: count(raw.total_results),
    results: raw.results.flatMap(item => summary(item, fallback) ?? [])
  };
}

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count0 = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

function genres(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(genre => record(genre) && positiveId(genre.id) && typeof genre.name === 'string'
    ? [{ id: genre.id, name: genre.name }] : []);
}

export function genreList(raw: unknown) {
  if (!record(raw) || !Array.isArray(raw.genres)) throw invalid();
  return { genres: genres(raw.genres) };
}

/** Normaliza el detalle de una película o serie; los campos de temporadas solo aplican a series. */
export function details(raw: unknown, type: MediaType, id: number) {
  if (!record(raw) || raw.id !== id) throw invalid();
  const title = type === 'movie' ? raw.title : raw.name;
  if (typeof title !== 'string') throw invalid();
  const original = type === 'movie' ? raw.original_title : raw.original_name;
  const common = {
    id, media_type: type, title,
    original_title: typeof original === 'string' ? original : title,
    overview: typeof raw.overview === 'string' ? raw.overview : '',
    tagline: textOrNull(raw.tagline),
    status: textOrNull(raw.status),
    poster_path: textOrNull(raw.poster_path),
    backdrop_path: textOrNull(raw.backdrop_path),
    release_date: textOrNull(type === 'movie' ? raw.release_date : raw.first_air_date),
    genres: genres(raw.genres),
    vote_average: number(raw.vote_average),
    vote_count: count0(raw.vote_count)
  };
  if (type === 'movie') return { ...common, runtime: count0(raw.runtime) || null };
  const runtimes = Array.isArray(raw.episode_run_time) ? raw.episode_run_time : [];
  return {
    ...common,
    runtime: count0(runtimes[0]) || null,
    number_of_seasons: count0(raw.number_of_seasons),
    number_of_episodes: count0(raw.number_of_episodes),
    seasons: (Array.isArray(raw.seasons) ? raw.seasons : []).flatMap(season => {
      if (!record(season) || count0(season.season_number) === null) return [];
      return [{
        season_number: season.season_number as number,
        name: typeof season.name === 'string' ? season.name : '',
        episode_count: count0(season.episode_count) ?? 0,
        air_date: textOrNull(season.air_date),
        poster_path: textOrNull(season.poster_path)
      }];
    })
  };
}

export type Params = Record<string, string | number | boolean>;

export function client(token: string, origin: string, timeout: number) {
  return async (path: string, params: Params) => {
    const url = new URL('/3' + path, origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    try {
      return await upstream(url, timeout, { Authorization: 'Bearer ' + token });
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) throw new HttpFailure(404, 'Contenido no encontrado');
      if (error instanceof HttpFailure && error.status === 429) throw new HttpFailure(429, 'Límite de solicitudes de TMDB alcanzado', error.retryAfter);
      if (error instanceof HttpFailure && error.status === 504) throw error;
      throw new HttpFailure(502, 'TMDB no disponible');
    }
  };
}

export type Tmdb = ReturnType<typeof client>;

/** Caché LRU con expiración que comparte las consultas en curso con los mismos argumentos. */
export function cached<A, V extends object>(ttl: number, max: number, load: (args: A) => Promise<V>) {
  const cache = new LRUCache<string, V>({
    ttl, max, ttlAutopurge: true,
    fetchMethod: key => load(JSON.parse(key) as A)
  });
  return async (args: A) => (await cache.fetch(JSON.stringify(args)))!;
}
