import { HttpFailure, upstream } from '../../shared/http.js';
import type { MediaType } from '../../shared/params.js';

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export type Ref = { media_type: MediaType; id: number };
export type Summary = Ref & {
  title: string; poster_path: string | null; overview: string; release_date: string | null;
  vote_average: number | null; genre_ids: number[];
};
export type LibraryItem = Ref & { seen: boolean };
export type Library = Record<'favorites' | 'watchlist' | 'progress', LibraryItem[]>;

export const key = (ref: Ref) => ref.media_type + ':' + ref.id;

// ───────────── Library Service ─────────────
// Contrato supuesto mientras se define Library: GET /api/v1/library/{favorites|watchlist|progress}
// con el mismo Bearer token, que responde una lista o { results: [...] } de elementos
// { tmdb_id, media_type, status?, completed? }. Ajustar `items` si el contrato final cambia.

const SEEN = new Set(['watched', 'completed', 'finished', 'seen', 'visto', 'vista', 'terminado', 'terminada']);

function items(raw: unknown): LibraryItem[] {
  const invalid = () => new HttpFailure(502, 'Respuesta inválida de Library Service');
  const list = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.results) ? raw.results : null;
  if (!list) throw invalid();
  return list.map(item => {
    if (!record(item) || (item.media_type !== 'movie' && item.media_type !== 'tv') || !positiveId(item.tmdb_id)) {
      throw invalid();
    }
    const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    return { media_type: item.media_type, id: item.tmdb_id, seen: item.completed === true || SEEN.has(status) };
  });
}

/**
 * Favoritos y watchlist son obligatorios: si Library no los expone, se responde con error para no
 * recomendar contenido ya visto. Progreso es opcional mientras se implementa: un 404 en esa ruta se
 * trata como lista vacía. Quitar 'progress' de este conjunto cuando Library lo publique.
 */
export const OPTIONAL_LISTS: ReadonlySet<keyof Library> = new Set(['progress']);

export function library(origin: string, timeout: number) {
  const list = async (name: keyof Library, token: string) => {
    let raw: unknown;
    try {
      raw = await upstream(new URL('/api/v1/library/' + name, origin), timeout, { Authorization: 'Bearer ' + token });
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) {
        if (OPTIONAL_LISTS.has(name)) return [];
        throw new HttpFailure(502, `Library Service no expone /api/v1/library/${name}`);
      }
      if (error instanceof HttpFailure && [401, 403].includes(error.status)) throw new HttpFailure(401, 'Token rechazado por Library Service');
      if (error instanceof HttpFailure && error.status === 504) throw error;
      throw new HttpFailure(502, 'Library Service no disponible');
    }
    return items(raw);
  };
  return async (token: string): Promise<Library> => {
    const [favorites, watchlist, progress] = await Promise.all(
      (['favorites', 'watchlist', 'progress'] as const).map(name => list(name, token)));
    return { favorites: favorites!, watchlist: watchlist!, progress: progress! };
  };
}

// ───────────── Media Service ─────────────

function summary(item: unknown): Summary {
  if (!record(item) || (item.media_type !== 'movie' && item.media_type !== 'tv') || !positiveId(item.id) ||
      typeof item.title !== 'string' || !Array.isArray(item.genre_ids)) {
    throw new HttpFailure(502, 'Respuesta inválida de Media Service');
  }
  return {
    id: item.id, media_type: item.media_type, title: item.title,
    poster_path: typeof item.poster_path === 'string' ? item.poster_path : null,
    overview: typeof item.overview === 'string' ? item.overview : '',
    release_date: typeof item.release_date === 'string' ? item.release_date : null,
    vote_average: typeof item.vote_average === 'number' ? item.vote_average : null,
    genre_ids: item.genre_ids.filter(positiveId)
  };
}

export function media(origin: string, timeout: number) {
  const get = async (path: string, params: Record<string, string>) => {
    const url = new URL('/api/v1/media' + path, origin);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    try {
      return await upstream(url, timeout);
    } catch (error) {
      if (error instanceof HttpFailure && [404, 429, 504].includes(error.status)) throw error;
      throw new HttpFailure(502, 'Media Service no disponible');
    }
  };
  const list = async (path: string, params: Record<string, string>) => {
    const raw = await get(path, params);
    if (!record(raw) || !Array.isArray(raw.results)) throw new HttpFailure(502, 'Respuesta inválida de Media Service');
    return raw.results.map(summary);
  };
  return {
    trending: (language: string) => list('/trending', { language }),
    popular: (type: MediaType, page: number, language: string) =>
      list('/popular', { media_type: type, page: String(page), language }),
    /** Géneros de un título; null si ya no existe en TMDB. */
    genresOf: async (ref: Ref, language: string) => {
      try {
        const raw = await get(`/${ref.media_type}/${ref.id}`, { language });
        if (!record(raw) || !Array.isArray(raw.genres)) throw new HttpFailure(502, 'Respuesta inválida de Media Service');
        return raw.genres.flatMap(genre => record(genre) && positiveId(genre.id) ? [genre.id] : []);
      } catch (error) {
        if (error instanceof HttpFailure && error.status === 404) return null;
        throw error;
      }
    }
  };
}
