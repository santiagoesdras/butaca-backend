import { LRUCache } from 'lru-cache';
import { bindHost, envInteger, httpUrl, loadConfig, optionalText, positiveInteger } from '../../shared/config.js';
import { finish, service } from '../../shared/http.js';
import { choice, language, limit, only, type MediaType } from '../../shared/params.js';
import { authenticator, type AuthConfig } from '../../shared/auth.js';
import { rank, seeds, type Recommendation } from './engine.js';
import { MOODS, type Mood } from './moods.js';
import { key, library, media } from './sources.js';

const MAX_RESULTS = 40;
const POPULAR_PAGES = [1, 2];

export type Config = {
  mediaOrigin: string;
  libraryOrigin: string;
  auth: AuthConfig;
  /** Espera máxima de cada llamada a Media o Library. */
  timeout?: number;
  /** Tiempo total para calcular una recomendación; debe ser menor que la espera del Gateway. */
  budget?: number;
};

type Result = {
  results: Recommendation[];
  mood: Mood | null;
  based_on: { favorites: number; watchlist: number; progress: number };
};

export function recommendations({ mediaOrigin, libraryOrigin, auth, timeout = 5000,
  budget = envInteger('RECOMMENDATIONS_BUDGET_MS', 6000) }: Config) {
  const authenticate = authenticator(auth);

  const compute = async (type: MediaType | 'all', lang: string, mood: Mood | null, token: string): Promise<Result> => {
    // Presupuesto total menor que la espera del Gateway (7 s): cada llamada usa como máximo lo que queda.
    const deadline = Date.now() + budget;
    const remaining = () => Math.min(timeout, deadline - Date.now());
    const mediaApi = media(mediaOrigin, remaining);
    const libraryOf = library(libraryOrigin, remaining);
    const types: MediaType[] = type === 'all' ? ['movie', 'tv'] : [type];

    const libraryRequest = libraryOf(token);
    // Los géneros de los títulos semilla se piden apenas responde Library, en paralelo con los listados.
    // Si falla el detalle de un título, se omite esa señal en lugar de fallar toda la recomendación.
    const signalsRequest = libraryRequest.then(userLibrary => Promise.all(seeds(userLibrary).map(async seed =>
      ({ weight: seed.weight, genres: await mediaApi.genresOf(seed, lang).catch(() => null) ?? [] }))));
    const [userLibrary, signals, trending, popular] = await Promise.all([
      libraryRequest,
      signalsRequest,
      mediaApi.trending(lang),
      // Una lista por tipo con sus páginas concatenadas, para que la posición refleje el ranking de TMDB.
      Promise.all(types.map(async t =>
        (await Promise.all(POPULAR_PAGES.map(page => mediaApi.popular(t, page, lang)))).flat()))
    ]);
    const excluded = new Set([...userLibrary.favorites, ...userLibrary.watchlist, ...userLibrary.progress].map(key));
    const results = rank({
      seeds: signals, excluded, popular, mood: mood ?? undefined,
      trending: trending.filter(item => types.includes(item.media_type))
    });
    return {
      results: results.slice(0, MAX_RESULTS),
      mood,
      based_on: {
        favorites: userLibrary.favorites.length,
        watchlist: userLibrary.watchlist.length,
        progress: userLibrary.progress.length
      }
    };
  };

  // Caché temporal por usuario: la clave usa el `sub` verificado, nunca el token.
  const cache = new LRUCache<string, Result, string>({
    ttl: envInteger('RECOMMENDATIONS_CACHE_TTL_MS', 120000),
    max: envInteger('CACHE_MAX_ENTRIES', 64) * 4,
    ttlAutopurge: true,
    fetchMethod: (cacheKey, _stale, { context }) => {
      const { type, language: lang, mood } = JSON.parse(cacheKey) as { type: MediaType | 'all'; language: string; mood: Mood | null };
      return compute(type, lang, mood, context);
    }
  });

  const app = service('recommendation-service');
  app.get('/api/v1/recommendations', async (req, res) => {
    const user = await authenticate(req.get('authorization'));
    only(req.query, ['media_type', 'limit', 'language', 'mood']);
    const type = choice(req.query, 'media_type', ['all', 'movie', 'tv'], 'all');
    const count = limit(req.query, MAX_RESULTS, 20);
    const mood = req.query.mood === undefined ? null : choice(req.query, 'mood', MOODS, MOODS[0]!);
    const cacheKey = JSON.stringify({ user: user.id, type, language: language(req.query), mood });
    const result = (await cache.fetch(cacheKey, { context: user.token }))!;
    res.set('Cache-Control', 'private, no-store');
    res.json({ results: result.results.slice(0, count), mood: result.mood, based_on: result.based_on });
  });
  return finish(app);
}

if (import.meta.main) {
  const config = loadConfig({
    SUPABASE_URL: httpUrl(),
    SUPABASE_JWT_AUDIENCE: optionalText,
    SUPABASE_JWT_SECRET: optionalText,
    MEDIA_ORIGIN: httpUrl('http://127.0.0.1:3001'),
    LIBRARY_ORIGIN: httpUrl('http://127.0.0.1:3002'),
    RECOMMENDATIONS_BUDGET_MS: positiveInteger(6000),
    RECOMMENDATIONS_CACHE_TTL_MS: positiveInteger(120000),
    CACHE_MAX_ENTRIES: positiveInteger(64),
    BIND_HOST: bindHost
  });
  recommendations({
    mediaOrigin: config.MEDIA_ORIGIN,
    libraryOrigin: config.LIBRARY_ORIGIN,
    budget: config.RECOMMENDATIONS_BUDGET_MS,
    auth: { supabaseUrl: config.SUPABASE_URL, audience: config.SUPABASE_JWT_AUDIENCE, jwtSecret: config.SUPABASE_JWT_SECRET }
  }).listen(3003, config.BIND_HOST);
}
