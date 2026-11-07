import { finish, HttpFailure, positiveInt, service } from '../../shared/http.js';
import { trending } from './tmdb.js';

export function media(token: string, origin = 'https://api.themoviedb.org', timeout = 4500) {
  if (!token.trim()) throw new Error('Se requiere TMDB_READ_ACCESS_TOKEN');
  const getTrending = trending(token, origin, positiveInt('CACHE_TTL_MS', 300000), positiveInt('CACHE_MAX_ENTRIES', 64), timeout);
  const app = service('media-service');
  app.get('/api/v1/media/trending', async (req, res) => {
    const language = req.query.language ?? 'es-MX';
    if (Object.keys(req.query).some(key => key !== 'language') ||
        typeof language !== 'string' || !/^[a-z]{2}-[A-Z]{2}$/.test(language)) {
      throw new HttpFailure(400, 'Se admite únicamente language con formato es-MX');
    }
    res.json(await getTrending(language));
  });
  return finish(app);
}

if (import.meta.main) {
  media(process.env.TMDB_READ_ACCESS_TOKEN ?? '').listen(3001, process.env.BIND_HOST ?? '127.0.0.1');
}
