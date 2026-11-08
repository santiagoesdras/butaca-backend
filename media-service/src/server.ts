import { finish, positiveInt, service } from '../../shared/http.js';
import { choice, language, only, page, searchText, type MediaType } from './params.js';
import { cached, client, paged } from './tmdb.js';

const base = '/api/v1/media';

export function media(token: string, origin = 'https://api.themoviedb.org', timeout = 4500) {
  if (!token.trim()) throw new Error('Se requiere TMDB_READ_ACCESS_TOKEN');
  const ttl = positiveInt('CACHE_TTL_MS', 300000);
  const max = positiveInt('CACHE_MAX_ENTRIES', 64);
  const tmdb = client(token, origin, timeout);

  const trending = cached(ttl, max, async (lang: string) => {
    const { page, results } = paged(await tmdb('/trending/all/day', { language: lang }));
    return { page, results };
  });

  const search = cached(ttl, max, async (q: { query: string; type: MediaType | 'all'; page: number; language: string }) => {
    const path = q.type === 'all' ? '/search/multi' : '/search/' + q.type;
    const raw = await tmdb(path, { query: q.query, page: q.page, language: q.language, include_adult: false });
    return paged(raw, q.type === 'all' ? undefined : q.type);
  });

  const app = service('media-service');

  app.get(base + '/trending', async (req, res) => {
    only(req.query, ['language']);
    res.json(await trending(language(req.query)));
  });

  app.get(base + '/search', async (req, res) => {
    only(req.query, ['query', 'media_type', 'page', 'language']);
    res.json(await search({
      query: searchText(req.query),
      type: choice(req.query, 'media_type', ['all', 'movie', 'tv'], 'all'),
      page: page(req.query),
      language: language(req.query)
    }));
  });

  return finish(app);
}

if (import.meta.main) {
  media(process.env.TMDB_READ_ACCESS_TOKEN ?? '').listen(3001, process.env.BIND_HOST ?? '127.0.0.1');
}
