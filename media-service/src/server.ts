import { finish, positiveInt, service } from '../../shared/http.js';
import { choice, language, mediaRef, only, page, searchText, type MediaType } from './params.js';
import { cached, client, details, genreList, paged } from './tmdb.js';

const base = '/api/v1/media';
const GENRES_TTL_MS = 24 * 60 * 60 * 1000;

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

  const detail = cached(ttl, max, async (q: { type: MediaType; id: number; language: string }) =>
    details(await tmdb(`/${q.type}/${q.id}`, { language: q.language }), q.type, q.id));

  const popularOf = cached(ttl, max, async (q: { type: MediaType; page: number; language: string }) =>
    paged(await tmdb(`/${q.type}/popular`, { page: q.page, language: q.language }), q.type));

  // Con `all` se intercalan películas y series de la misma página para alternar ambos tipos.
  const popular = async (type: MediaType | 'all', page: number, lang: string) => {
    if (type !== 'all') return popularOf({ type, page, language: lang });
    const [movies, shows] = await Promise.all([
      popularOf({ type: 'movie', page, language: lang }), popularOf({ type: 'tv', page, language: lang })
    ]);
    const results = Array.from({ length: Math.max(movies.results.length, shows.results.length) },
      (_, i) => [movies.results[i], shows.results[i]]).flat().filter(item => item !== undefined);
    return {
      page,
      total_pages: Math.min(movies.total_pages, shows.total_pages),
      total_results: movies.total_results + shows.total_results,
      results
    };
  };

  // Los catálogos de géneros casi no cambian: se conservan un día por tipo e idioma.
  const genreCatalog = cached(GENRES_TTL_MS, max, async (q: { type: MediaType; language: string }) =>
    genreList(await tmdb(`/genre/${q.type}/list`, { language: q.language })));

  const genres = async (type: MediaType | 'all', lang: string) => {
    const types: MediaType[] = type === 'all' ? ['movie', 'tv'] : [type];
    const lists = await Promise.all(types.map(t => genreCatalog({ type: t, language: lang })));
    const merged = new Map<number, { id: number; name: string; media_types: MediaType[] }>();
    lists.forEach((list, index) => {
      for (const { id, name } of list.genres) {
        const entry = merged.get(id) ?? { id, name, media_types: [] };
        entry.media_types.push(types[index]!);
        merged.set(id, entry);
      }
    });
    const collator = new Intl.Collator(lang);
    return { genres: [...merged.values()].sort((a, b) => collator.compare(a.name, b.name)) };
  };

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

  app.get(base + '/popular', async (req, res) => {
    only(req.query, ['media_type', 'page', 'language']);
    res.json(await popular(
      choice(req.query, 'media_type', ['all', 'movie', 'tv'], 'all'), page(req.query), language(req.query)));
  });

  app.get(base + '/genres', async (req, res) => {
    only(req.query, ['media_type', 'language']);
    res.json(await genres(choice(req.query, 'media_type', ['all', 'movie', 'tv'], 'all'), language(req.query)));
  });

  // Debe registrarse después de las rutas fijas de un segmento.
  app.get(base + '/:media_type/:id', async (req, res) => {
    const { type, id } = mediaRef(req.params);
    only(req.query, ['language']);
    res.json(await detail({ type, id, language: language(req.query) }));
  });

  return finish(app);
}

if (import.meta.main) {
  media(process.env.TMDB_READ_ACCESS_TOKEN ?? '').listen(3001, process.env.BIND_HOST ?? '127.0.0.1');
}
