import { LRUCache } from 'lru-cache';
import { finish, positiveInt, service } from '../../shared/http.js';
import { choice, language, limit, only, type MediaType } from '../../shared/params.js';
import { authenticator, type AuthConfig } from '../../shared/auth.js';
import { rank, seeds, type Recommendation } from './engine.js';
import { key, library, media } from './sources.js';

const MAX_RESULTS = 40;
const POPULAR_PAGES = [1, 2];

export type Config = {
  mediaOrigin: string;
  libraryOrigin: string;
  auth: AuthConfig;
  timeout?: number;
};

type Result = { results: Recommendation[]; based_on: { favorites: number; watchlist: number; progress: number } };

export function recommendations({ mediaOrigin, libraryOrigin, auth, timeout = 5000 }: Config) {
  const authenticate = authenticator(auth);
  const mediaApi = media(mediaOrigin, timeout);
  const libraryOf = library(libraryOrigin, timeout);

  const compute = async (type: MediaType | 'all', lang: string, token: string): Promise<Result> => {
    const types: MediaType[] = type === 'all' ? ['movie', 'tv'] : [type];
    const [userLibrary, trending, popular] = await Promise.all([
      libraryOf(token),
      mediaApi.trending(lang),
      // Una lista por tipo con sus páginas concatenadas, para que la posición refleje el ranking de TMDB.
      Promise.all(types.map(async t =>
        (await Promise.all(POPULAR_PAGES.map(page => mediaApi.popular(t, page, lang)))).flat()))
    ]);
    const signals = await Promise.all(seeds(userLibrary).map(async seed =>
      ({ weight: seed.weight, genres: await mediaApi.genresOf(seed, lang) ?? [] })));
    const excluded = new Set([...userLibrary.favorites, ...userLibrary.watchlist, ...userLibrary.progress].map(key));
    const results = rank({
      seeds: signals, excluded, popular,
      trending: trending.filter(item => types.includes(item.media_type))
    });
    return {
      results: results.slice(0, MAX_RESULTS),
      based_on: {
        favorites: userLibrary.favorites.length,
        watchlist: userLibrary.watchlist.length,
        progress: userLibrary.progress.length
      }
    };
  };

  // Caché temporal por usuario: la clave usa el `sub` verificado, nunca el token.
  const cache = new LRUCache<string, Result, string>({
    ttl: positiveInt('RECOMMENDATIONS_CACHE_TTL_MS', 120000),
    max: positiveInt('CACHE_MAX_ENTRIES', 64) * 4,
    ttlAutopurge: true,
    fetchMethod: (cacheKey, _stale, { context }) => {
      const { type, language: lang } = JSON.parse(cacheKey) as { type: MediaType | 'all'; language: string };
      return compute(type, lang, context);
    }
  });

  const app = service('recommendation-service');
  app.get('/api/v1/recommendations', async (req, res) => {
    const user = await authenticate(req.get('authorization'));
    only(req.query, ['media_type', 'limit', 'language']);
    const type = choice(req.query, 'media_type', ['all', 'movie', 'tv'], 'all');
    const count = limit(req.query, MAX_RESULTS, 20);
    const cacheKey = JSON.stringify({ user: user.id, type, language: language(req.query) });
    const result = (await cache.fetch(cacheKey, { context: user.token }))!;
    res.set('Cache-Control', 'private, no-store');
    res.json({ results: result.results.slice(0, count), based_on: result.based_on });
  });
  return finish(app);
}

if (import.meta.main) {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  if (!/^https?:\/\//.test(supabaseUrl)) throw new Error('Se requiere SUPABASE_URL');
  recommendations({
    mediaOrigin: process.env.MEDIA_ORIGIN ?? 'http://127.0.0.1:3001',
    libraryOrigin: process.env.LIBRARY_ORIGIN ?? 'http://127.0.0.1:3002',
    auth: {
      supabaseUrl,
      audience: process.env.SUPABASE_JWT_AUDIENCE || undefined,
      jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined
    }
  }).listen(3003, process.env.BIND_HOST ?? '127.0.0.1');
}
