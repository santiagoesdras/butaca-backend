import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { finish, HttpFailure, service, upstream } from '../../shared/http.js';
import { authenticator, type AuthConfig } from '../../shared/auth.js';

const media = '/api/v1/media';

// Evita que segmentos como `..` alteren la ruta interna; Media valida el valor exacto.
function segment(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new HttpFailure(400, 'Ruta inválida');
  return value;
}

export function gateway(mediaOrigin: string, frontendOrigin: string, auth?: Pick<AuthConfig, 'supabaseUrl' | 'audience'>,
  recommendationOrigin?: string, recommendationTimeout = 7000, libraryOrigin?: string) {
  const authenticate = auth ? authenticator({ ...auth, algorithms: ['ES256'] }) : undefined;
  const app = service('api-gateway');
  app.use(helmet());
  app.use(cors({
    origin: frontendOrigin,
    methods: ['GET', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Sin esto el navegador oculta estos encabezados al frontend en peticiones entre orígenes.
    exposedHeaders: ['Retry-After', 'RateLimit', 'RateLimit-Policy']
  }));
  app.use('/api', rateLimit({
    windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes' }
  }));

  app.use(['/api/v1/library', '/api/v1/recommendations'], async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!authenticate) throw new HttpFailure(503, 'Autenticación no configurada');
    try {
      res.locals.user = await authenticate(req.get('authorization'));
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 401) res.set('WWW-Authenticate', 'Bearer');
      throw error;
    }
    next();
  });

  // Reenvía la consulta a Media Service conservando la query string y los errores del cliente.
  const forward = (route: string, target: (req: Request) => string = () => route) =>
    app.get(route, async (req, res) => {
      const url = new URL(target(req), mediaOrigin);
      url.search = new URL(req.originalUrl, 'http://gateway').search;
      try {
        res.json(await upstream(url, 7000));
      } catch (error) {
        if (error instanceof HttpFailure && [400, 404, 429, 504].includes(error.status)) throw error;
        throw new HttpFailure(502, 'Media Service no disponible');
      }
    });

  forward(media + '/trending');
  forward(media + '/search');
  forward(media + '/genres');
  forward(media + '/popular');
  forward(media + '/:media_type/:id', req => `${media}/${segment(req.params.media_type)}/${segment(req.params.id)}`);

  const watchlist = '/api/v1/library/watchlist';
  const progress = '/api/v1/library/progress';
  const favorites = '/api/v1/library/favorites';
  const forwardLibrary = async (req: Request, res: express.Response) => {
    if (!libraryOrigin) throw new HttpFailure(503, 'Library Service no configurado');
    const domain = [progress, favorites, watchlist].find(prefix => req.route.path.startsWith(prefix))!;
    const episode = req.params.season !== undefined;
    const path = req.method === 'GET' ? domain
      : `${domain}/${episode ? 'tv' : segment(req.params.media_type)}/${segment(req.params.tmdb_id)}` +
        (episode ? `/episodes/${segment(req.params.season)}/${segment(req.params.episode)}` : '');
    const url = new URL(path, libraryOrigin);
    url.search = new URL(req.originalUrl, 'http://gateway').search;
    const headers: Record<string, string> = { Authorization: 'Bearer ' + res.locals.user.token };
    if (req.get('content-type')) headers['Content-Type'] = req.get('content-type')!;
    const signal = AbortSignal.timeout(7000);
    try {
      const response = await fetch(url, {
        method: req.method, headers, signal, redirect: 'error',
        body: req.method === 'GET' || !Buffer.isBuffer(req.body) ? undefined : new Uint8Array(req.body)
      });
      if (response.status === 204) return res.status(204).end();
      if (response.status === 401) res.set('WWW-Authenticate', 'Bearer');
      const retry = response.headers.get('retry-after');
      if (retry && /^\d{1,9}$/.test(retry)) res.set('Retry-After', retry);
      if (![200, 400, 401, 403, 404, 409, 413, 415, 429, 503, 504].includes(response.status)) {
        throw new HttpFailure(502, 'Library Service no disponible');
      }
      res.status(response.status).json(await response.json());
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      throw new HttpFailure(signal.aborted ? 504 : 502,
        signal.aborted ? 'Tiempo de espera agotado' : 'Library Service no disponible');
    }
  };
  const body = express.raw({ type: () => true, limit: '1kb' });
  app.get(watchlist, forwardLibrary);
  app.put(watchlist + '/:media_type/:tmdb_id', body, forwardLibrary);
  app.delete(watchlist + '/:media_type/:tmdb_id', body, forwardLibrary);
  app.get(favorites, forwardLibrary);
  app.put(favorites + '/:media_type/:tmdb_id', body, forwardLibrary);
  app.delete(favorites + '/:media_type/:tmdb_id', body, forwardLibrary);
  app.get(progress, forwardLibrary);
  app.put(progress + '/:media_type/:tmdb_id', body, forwardLibrary);
  app.put(progress + '/tv/:tmdb_id/episodes/:season/:episode', body, forwardLibrary);
  app.delete(progress + '/tv/:tmdb_id/episodes/:season/:episode', body, forwardLibrary);

  app.get('/api/v1/recommendations', async (req, res) => {
    if (!recommendationOrigin) throw new HttpFailure(503, 'Recommendation Service no configurado');
    const url = new URL('/api/v1/recommendations', recommendationOrigin);
    url.search = new URL(req.originalUrl, 'http://gateway').search;
    try {
      res.json(await upstream(url, recommendationTimeout, {
        Authorization: 'Bearer ' + res.locals.user.token
      }));
    } catch (error) {
      if (error instanceof HttpFailure && [400, 401, 403, 429, 503, 504].includes(error.status)) {
        if (error.status === 401) res.set('WWW-Authenticate', 'Bearer');
        throw error;
      }
      throw new HttpFailure(502, 'Recommendation Service no disponible');
    }
  });
  const bodyErrors: ErrorRequestHandler = (error: unknown, _req, _res, next) => {
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') return next(new HttpFailure(413, 'Cuerpo demasiado grande'));
    if (type === 'encoding.unsupported') return next(new HttpFailure(415, 'Formato no admitido'));
    next(error);
  };
  app.use(bodyErrors);
  return finish(app);
}

if (import.meta.main) {
  const supabaseUrl = process.env.SUPABASE_URL;
  gateway(
    process.env.MEDIA_ORIGIN ?? 'http://127.0.0.1:3001',
    process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    supabaseUrl ? { supabaseUrl, audience: process.env.SUPABASE_JWT_AUDIENCE || 'authenticated' } : undefined,
    process.env.RECOMMENDATION_ORIGIN,
    7000,
    process.env.LIBRARY_ORIGIN
  )
    .listen(8080, process.env.BIND_HOST ?? '127.0.0.1');
}
