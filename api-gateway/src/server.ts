import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { finish, HttpFailure, service, upstream } from '../../shared/http.js';
import { authenticator, type AuthConfig } from '../../shared/auth.js';

const media = '/api/v1/media';

// Evita que segmentos como `..` alteren la ruta interna; Media valida el valor exacto.
function segment(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new HttpFailure(400, 'Ruta inválida');
  return value;
}

export function gateway(mediaOrigin: string, frontendOrigin: string, auth?: Pick<AuthConfig, 'supabaseUrl' | 'audience'>,
  recommendationOrigin?: string, recommendationTimeout = 7000) {
  const authenticate = auth ? authenticator({ ...auth, algorithms: ['ES256'] }) : undefined;
  const app = service('api-gateway');
  app.use(helmet());
  app.use(cors({ origin: frontendOrigin, methods: ['GET'] }));
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
  return finish(app);
}

if (import.meta.main) {
  const supabaseUrl = process.env.SUPABASE_URL;
  gateway(
    process.env.MEDIA_ORIGIN ?? 'http://127.0.0.1:3001',
    process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    supabaseUrl ? { supabaseUrl, audience: process.env.SUPABASE_JWT_AUDIENCE || 'authenticated' } : undefined,
    process.env.RECOMMENDATION_ORIGIN
  )
    .listen(8080, process.env.BIND_HOST ?? '127.0.0.1');
}
