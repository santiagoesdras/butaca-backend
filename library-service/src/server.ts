import express, { type ErrorRequestHandler } from 'express';
import { authenticator, type AuthConfig } from '../../shared/auth.js';
import { finish, HttpFailure, service } from '../../shared/http.js';
import { only } from '../../shared/params.js';
import type { MediaRef, WatchlistStore } from './watchlist.js';
import { progressInput, type EpisodeRef, type ProgressStore } from './progress.js';
import type { FavoriteStore } from './favorites.js';

const base = '/api/v1/library';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reference(params: Record<string, unknown>): MediaRef {
  const { media_type, tmdb_id } = params;
  if (media_type !== 'movie' && media_type !== 'tv') throw new HttpFailure(400, 'media_type debe ser movie o tv');
  if (typeof tmdb_id !== 'string' || !/^[1-9]\d{0,9}$/.test(tmdb_id) || Number(tmdb_id) > 2147483647) {
    throw new HttpFailure(400, 'tmdb_id debe ser un entero entre 1 y 2147483647');
  }
  return { media_type, tmdb_id: Number(tmdb_id) };
}

export function library(store: WatchlistStore, auth: Pick<AuthConfig, 'supabaseUrl' | 'audience'>, progress?: ProgressStore,
  favorites?: FavoriteStore) {
  const authenticate = authenticator({ ...auth, algorithms: ['ES256'] });
  const app = service('library-service');
  app.use(base, async (req, res, next) => {
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
  app.use(base, express.json({ limit: '1kb' }));
  app.use(base, (req, _res, next) => {
    only(req.query, []);
    next();
  });
  const emptyBody: express.RequestHandler = (req, _res, next) => {
    if (req.body !== undefined && (req.body === null || Array.isArray(req.body) ||
      typeof req.body !== 'object' || Object.keys(req.body).length > 0)) {
      throw new HttpFailure(400, 'Esta operación no admite campos en el cuerpo');
    }
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
    const episodeRef = (params: Record<string, unknown>): EpisodeRef => {
      const number = (value: unknown, minimum: number) => {
        if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(value) || Number(value) < minimum || Number(value) > 2147483647) {
          throw new HttpFailure(400, 'Temporada o episodio inválidos');
        }
        return Number(value);
      };
      return { season: number(params.season, 0), episode: number(params.episode, 1) };
    };
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
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl || !process.env.DATABASE_URL) throw new Error('Se requieren SUPABASE_URL y DATABASE_URL');
  // La salud del proceso no depende de una consulta a la base de datos.
  const { prisma } = await import('./db.js');
  const { watchlistStore } = await import('./watchlist.js');
  const { progressStore } = await import('./progress.js');
  const { favoritesStore } = await import('./favorites.js');
  library(watchlistStore(prisma), {
    supabaseUrl, audience: process.env.SUPABASE_JWT_AUDIENCE || 'authenticated'
  }, progressStore(prisma), favoritesStore(prisma)).listen(3002, process.env.BIND_HOST ?? '127.0.0.1', () => {
    console.log(JSON.stringify({ service: 'library-service', event: 'listening', port: 3002 }));
  });
}
