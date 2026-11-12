import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { finish, HttpFailure, service, upstream } from '../../shared/http.js';
import { authenticator, type AuthConfig } from '../../shared/auth.js';
import { bindHost, httpUrl, loadConfig, optionalHttpUrl, textWithDefault } from '../../shared/config.js';
import { parse } from '../../shared/validate.js';
import { z } from 'zod';

const media = '/api/v1/media';

// Evita que segmentos como `..` alteren la ruta interna; Media valida el valor exacto.
const segmentSchema = z.string({ error: 'Ruta inválida' }).regex(/^[A-Za-z0-9_-]{1,32}$/, 'Ruta inválida');
const segment = (value: unknown) => parse(segmentSchema, value);

export function gateway(mediaOrigin: string, frontendOrigin: string, auth?: Pick<AuthConfig, 'supabaseUrl' | 'audience'>,
  recommendationOrigin?: string, recommendationTimeout = 7000, libraryOrigin?: string) {
  const authenticate = auth ? authenticator({ ...auth, algorithms: ['ES256'] }) : undefined;
  const app = service('api-gateway');
  app.use(helmet());
  app.use(cors({
    origin: frontendOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Sin esto el navegador oculta estos encabezados al frontend en peticiones entre orígenes.
    exposedHeaders: ['Retry-After', 'RateLimit', 'RateLimit-Policy']
  }));
  app.use('/api', rateLimit({
    windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes' }
  }));

  app.use(['/api/v1/library', '/api/v1/emotions', '/api/v1/recommendations'], async (req, res, next) => {
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
  // Reenvía a Library con el JWT verificado, conservando cuerpo, query y errores del cliente.
  const relay = async (req: Request, res: express.Response, path: string, timeout = 7000) => {
    if (!libraryOrigin) throw new HttpFailure(503, 'Library Service no configurado');
    const url = new URL(path, libraryOrigin);
    url.search = new URL(req.originalUrl, 'http://gateway').search;
    const headers: Record<string, string> = { Authorization: 'Bearer ' + res.locals.user.token };
    if (req.get('content-type')) headers['Content-Type'] = req.get('content-type')!;
    const signal = AbortSignal.timeout(timeout);
    try {
      const response = await fetch(url, {
        method: req.method, headers, signal, redirect: 'error',
        body: req.method === 'GET' || !Buffer.isBuffer(req.body) ? undefined : new Uint8Array(req.body)
      });
      if (response.status === 204) return res.status(204).end();
      if (response.status === 401) res.set('WWW-Authenticate', 'Bearer');
      const retry = response.headers.get('retry-after');
      if (retry && /^\d{1,9}$/.test(retry)) res.set('Retry-After', retry);
      for (const name of ['ratelimit', 'ratelimit-policy']) {
        const value = response.headers.get(name);
        if (value && value.length <= 200) res.set(name, value);
      }
      if (![200, 201, 400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503, 504].includes(response.status)) {
        throw new HttpFailure(502, 'Library Service no disponible');
      }
      res.status(response.status).json(await response.json());
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      throw new HttpFailure(signal.aborted ? 504 : 502,
        signal.aborted ? 'Tiempo de espera agotado' : 'Library Service no disponible');
    }
  };
  const forwardLibrary = (req: Request, res: express.Response) => {
    const domain = [progress, favorites, watchlist].find(prefix => req.route.path.startsWith(prefix))!;
    const episode = req.params.season !== undefined;
    const path = req.method === 'GET' ? domain
      : `${domain}/${episode ? 'tv' : segment(req.params.media_type)}/${segment(req.params.tmdb_id)}` +
        (episode ? `/episodes/${segment(req.params.season)}/${segment(req.params.episode)}` : '');
    return relay(req, res, path);
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

  const emotions = '/api/v1/emotions';
  const uuid = (value: unknown) => parse(z.uuid({ error: 'Ruta inválida' }), value);
  app.get(emotions + '/consent', (req, res) => relay(req, res, emotions + '/consent'));
  app.put(emotions + '/consent', body, (req, res) => relay(req, res, emotions + '/consent'));
  app.delete(emotions + '/consent', body, (req, res) => relay(req, res, emotions + '/consent'));
  // Multipart se acepta solo en esta ruta; Library valida archivo, consentimiento y contenido real.
  app.post(emotions + '/analyze', express.raw({ type: 'multipart/form-data', limit: '3mb' }),
    (req, res) => relay(req, res, emotions + '/analyze', 8000));
  // Registro de la emoción confirmada: JSON pequeño, sin imagen.
  app.post(emotions + '/history', body, (req, res) => relay(req, res, emotions + '/history'));
  app.get(emotions + '/history', (req, res) => relay(req, res, emotions + '/history'));
  app.get(emotions + '/summary', (req, res) => relay(req, res, emotions + '/summary'));
  app.put(emotions + '/history/:id/recommendations/:media_type/:tmdb_id', express.raw({ type: () => true, limit: '8kb' }),
    (req, res) => relay(req, res,
      `${emotions}/history/${uuid(req.params.id)}/recommendations/${segment(req.params.media_type)}/${segment(req.params.tmdb_id)}`));

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
  const config = loadConfig({
    MEDIA_ORIGIN: httpUrl('http://127.0.0.1:3001'),
    FRONTEND_ORIGIN: httpUrl('http://localhost:5173'),
    // Sin SUPABASE_URL las rutas privadas responden 503; las públicas siguen disponibles.
    SUPABASE_URL: optionalHttpUrl,
    SUPABASE_JWT_AUDIENCE: textWithDefault('authenticated'),
    RECOMMENDATION_ORIGIN: optionalHttpUrl,
    LIBRARY_ORIGIN: optionalHttpUrl,
    BIND_HOST: bindHost
  });
  gateway(
    config.MEDIA_ORIGIN,
    config.FRONTEND_ORIGIN,
    config.SUPABASE_URL ? { supabaseUrl: config.SUPABASE_URL, audience: config.SUPABASE_JWT_AUDIENCE } : undefined,
    config.RECOMMENDATION_ORIGIN,
    7000,
    config.LIBRARY_ORIGIN
  )
    .listen(8080, config.BIND_HOST);
}
