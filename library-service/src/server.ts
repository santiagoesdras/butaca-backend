import express, { type ErrorRequestHandler } from 'express';
import { authenticator, type AuthConfig } from '../../shared/auth.js';
import { bindHost, httpUrl, loadConfig, optionalText, positiveInteger, postgresUrl, textWithDefault } from '../../shared/config.js';
import { finish, HttpFailure, service } from '../../shared/http.js';
import { mediaTypeSchema, only, tmdbIdText } from '../../shared/params.js';
import { parse } from '../../shared/validate.js';
import { z } from 'zod';
import type { MediaRef, WatchlistStore } from './watchlist.js';
import { progressInput, type EpisodeRef, type ProgressStore } from './progress.js';
import type { FavoriteStore } from './favorites.js';
import type { ProfileStore } from './profiles.js';
import { emotionsBase, emotionRoutes, type EmotionDeps } from './emotion-routes.js';

/** Dependencias opcionales de Library; se agregan sin cambiar los parámetros existentes. */
export type LibraryExtras = { profiles?: ProfileStore; emotions?: EmotionDeps };

const base = '/api/v1/library';
// Dominios privados: requieren JWT y aseguran el perfil antes de escribir.
const privateBases = [base, emotionsBase];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const referenceSchema = z.object({
  media_type: mediaTypeSchema,
  tmdb_id: tmdbIdText('tmdb_id debe ser un entero entre 1 y 2147483647')
});
const reference = (params: Record<string, unknown>): MediaRef => parse(referenceSchema, params);

const episodeNumber = (minimum: number) => z.string({ error: 'Temporada o episodio inválidos' })
  .regex(/^(0|[1-9]\d{0,9})$/, 'Temporada o episodio inválidos').transform(Number)
  .refine(value => value >= minimum && value <= 2147483647, 'Temporada o episodio inválidos');
const episodeSchema = z.object({ season: episodeNumber(0), episode: episodeNumber(1) });

// Sin cuerpo, o un objeto JSON vacío: nunca se aceptan campos (por ejemplo, un user_id inyectado).
const emptyBodySchema = z.union([z.undefined(), z.object({}).strict()], { error: 'Esta operación no admite campos en el cuerpo' });

export function library(store: WatchlistStore, auth: Pick<AuthConfig, 'supabaseUrl' | 'audience'>, progress?: ProgressStore,
  favorites?: FavoriteStore, { profiles, emotions }: LibraryExtras = {}) {
  const authenticate = authenticator({ ...auth, algorithms: ['ES256'] });
  const app = service('library-service');
  app.use(privateBases, async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const user = await authenticate(req.get('authorization'));
      if (!uuid.test(user.id)) throw new HttpFailure(401, 'Token sin identificador de usuario válido');
      res.locals.user = user;
      next();
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 401) res.set('WWW-Authenticate', 'Bearer');
      throw error;
    }
  });
  // Antes de cualquier escritura se asegura el perfil del usuario verificado.
  if (profiles) {
    app.use(privateBases, async (req, res, next) => {
      const statelessAnalysis = req.method === 'POST' && req.originalUrl.split('?')[0] === emotionsBase + '/analyze';
      if (!statelessAnalysis && (req.method === 'PUT' || req.method === 'POST')) await profiles.ensure(res.locals.user.id);
      next();
    });
  }
  app.use(base, express.json({ limit: '1kb' }));
  app.use(base, (req, _res, next) => {
    only(req.query, []);
    next();
  });
  const emptyBody: express.RequestHandler = (req, _res, next) => {
    parse(emptyBodySchema, req.body);
    next();
  };

  app.get(base + '/watchlist', emptyBody, async (_req, res) => {
    res.json({ results: await store.list(res.locals.user.id) });
  });
  app.put(base + '/watchlist/:media_type/:tmdb_id', emptyBody, async (req, res) => {
    res.json(await store.add(res.locals.user.id, reference(req.params)));
  });
  app.delete(base + '/watchlist/:media_type/:tmdb_id', emptyBody, async (req, res) => {
    await store.remove(res.locals.user.id, reference(req.params));
    res.status(204).end();
  });

  if (favorites) {
    app.get(base + '/favorites', emptyBody, async (_req, res) => {
      res.json({ results: await favorites.list(res.locals.user.id) });
    });
    app.put(base + '/favorites/:media_type/:tmdb_id', emptyBody, async (req, res) => {
      res.json(await favorites.add(res.locals.user.id, reference(req.params)));
    });
    app.delete(base + '/favorites/:media_type/:tmdb_id', emptyBody, async (req, res) => {
      await favorites.remove(res.locals.user.id, reference(req.params));
      res.status(204).end();
    });
  }

  if (progress) {
    const episodeRef = (params: Record<string, unknown>): EpisodeRef => parse(episodeSchema, params);
    const seriesRef = (params: Record<string, unknown>): MediaRef => reference({ ...params, media_type: 'tv' });
    app.get(base + '/progress', emptyBody, async (_req, res) => res.json({ results: await progress.list(res.locals.user.id) }));
    app.put(base + '/progress/:media_type/:tmdb_id', async (req, res) => {
      const ref = reference(req.params);
      res.json(await progress.set(res.locals.user.id, ref, progressInput(req.body, ref)));
    });
    const episodes = base + '/progress/tv/:tmdb_id/episodes/:season/:episode';
    app.put(episodes, emptyBody, async (req, res) => {
      res.json(await progress.markEpisode(res.locals.user.id, seriesRef(req.params), episodeRef(req.params)));
    });
    app.delete(episodes, emptyBody, async (req, res) => {
      await progress.removeEpisode(res.locals.user.id, seriesRef(req.params), episodeRef(req.params));
      res.status(204).end();
    });
  }

  if (emotions) emotionRoutes(app, emotions);

  const errors: ErrorRequestHandler = (error: unknown, _req, _res, next) => {
    if (error instanceof HttpFailure) return next(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') return next(new HttpFailure(413, 'Cuerpo demasiado grande'));
    if (type === 'entity.parse.failed') return next(new HttpFailure(400, 'JSON inválido'));
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') return next(new HttpFailure(415, 'Formato no admitido'));
    if (code === 'P2003') return next(new HttpFailure(409, 'El perfil del usuario no está preparado en Library'));
    if (code === 'P2002') return next(new HttpFailure(409, 'El elemento ya existe; vuelve a consultar la lista'));
    console.error(JSON.stringify({ service: 'library-service', event: 'watchlist_failed' }));
    next(new HttpFailure(503, 'Library no disponible'));
  };
  app.use(errors);
  return finish(app);
}

if (import.meta.main) {
  const config = loadConfig({
    SUPABASE_URL: httpUrl(),
    SUPABASE_JWT_AUDIENCE: textWithDefault('authenticated'),
    DATABASE_URL: postgresUrl,
    // Sin AWS_REGION el análisis responde 503; las demás rutas siguen disponibles.
    AWS_REGION: optionalText,
    EMOTION_MIN_CONFIDENCE: positiveInteger(30, 100),
    EMOTION_AWS_TIMEOUT_MS: positiveInteger(5000),
    EMOTION_ANALYZE_LIMIT: positiveInteger(10),
    EMOTION_ANALYZE_WINDOW_MS: positiveInteger(60000),
    BIND_HOST: bindHost
  });
  // La salud del proceso no depende de una consulta a la base de datos.
  const { prisma } = await import('./db.js');
  const { watchlistStore } = await import('./watchlist.js');
  const { progressStore } = await import('./progress.js');
  const { favoritesStore } = await import('./favorites.js');
  const { profilesStore } = await import('./profiles.js');
  const { emotionStore } = await import('./emotions.js');
  const { rekognitionDetector } = await import('./detector.js');
  library(watchlistStore(prisma), {
    supabaseUrl: config.SUPABASE_URL, audience: config.SUPABASE_JWT_AUDIENCE
  }, progressStore(prisma), favoritesStore(prisma), {
    profiles: profilesStore(prisma),
    emotions: {
      store: emotionStore(prisma),
      detector: config.AWS_REGION ? rekognitionDetector(config.AWS_REGION, config.EMOTION_AWS_TIMEOUT_MS) : undefined,
      analyze: {
        minConfidence: config.EMOTION_MIN_CONFIDENCE,
        limit: config.EMOTION_ANALYZE_LIMIT,
        windowMs: config.EMOTION_ANALYZE_WINDOW_MS
      }
    }
  }).listen(3002, config.BIND_HOST, () => {
    console.log(JSON.stringify({ service: 'library-service', event: 'listening', port: 3002 }));
  });
}
