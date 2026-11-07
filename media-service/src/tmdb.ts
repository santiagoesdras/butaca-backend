import { LRUCache } from 'lru-cache';
import { HttpFailure, upstream } from '../../shared/http.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalize(raw: unknown) {
  const invalid = () => new HttpFailure(502, 'Respuesta inválida de TMDB');
  if (!record(raw) || !Array.isArray(raw.results) || !Number.isSafeInteger(raw.page)) throw invalid();
  const results = raw.results.flatMap((item: unknown) => {
    if (!record(item)) throw invalid();
    if (item.media_type === 'person') return [];
    const type = item.media_type;
    const title = type === 'movie' ? item.title : item.name;
    if ((type !== 'movie' && type !== 'tv') || typeof title !== 'string' ||
        typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0) throw invalid();
    return [{ id: item.id, media_type: type, title,
      poster_path: typeof item.poster_path === 'string' ? item.poster_path : null }];
  });
  return { page: raw.page as number, results };
}

export function trending(token: string, origin: string, ttl: number, max: number, timeout: number) {
  const cache = new LRUCache<string, ReturnType<typeof normalize>>({
    ttl, max, ttlAutopurge: true,
    fetchMethod: async language => {
      const url = new URL('/3/trending/all/day', origin);
      url.searchParams.set('language', language);
      try {
        return normalize(await upstream(url, timeout, { Authorization: 'Bearer ' + token }));
      } catch (error) {
        if (error instanceof HttpFailure && [429, 504].includes(error.status)) throw error;
        throw new HttpFailure(502, 'TMDB no disponible');
      }
    }
  });
  return (language: string) => cache.fetch(language);
}
