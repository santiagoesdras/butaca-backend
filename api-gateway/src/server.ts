import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { finish, HttpFailure, service, upstream } from '../../shared/http.js';

const path = '/api/v1/media/trending';

export function gateway(mediaOrigin: string, frontendOrigin: string) {
  const app = service('api-gateway');
  app.use(helmet());
  app.use(cors({ origin: frontendOrigin, methods: ['GET'] }));
  app.use('/api', rateLimit({
    windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes' }
  }));
  app.get(path, async (req, res) => {
    const target = new URL(path, mediaOrigin);
    target.search = new URL(req.originalUrl, 'http://gateway').search;
    try {
      res.json(await upstream(target, 7000));
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 400) throw new HttpFailure(400, 'Parámetros de tendencias inválidos');
      if (error instanceof HttpFailure && error.status === 429) throw new HttpFailure(429, 'Demasiadas solicitudes', error.retryAfter);
      if (error instanceof HttpFailure && error.status === 504) throw error;
      throw new HttpFailure(502, 'Media Service no disponible');
    }
  });
  return finish(app);
}

if (import.meta.main) {
  gateway(process.env.MEDIA_ORIGIN ?? 'http://127.0.0.1:3001', process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .listen(8080, process.env.BIND_HOST ?? '127.0.0.1');
}
