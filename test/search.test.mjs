import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { fakeTmdb, listen, summary } from './helpers.mjs';

test('Búsqueda de películas y series', async t => {
  const tmdb = fakeTmdb({
    '/3/search/multi': params => ({
      page: Number(params.get('page')), total_pages: 900, total_results: 3,
      results: [
        { media_type: 'movie', id: 10, title: 'Dune', release_date: '2021-09-15', genre_ids: [878, 12], poster_path: '/d.jpg' },
        { media_type: 'person', id: 99, name: 'Actor' },
        { media_type: 'tv', id: 20, name: 'Dune: Prophecy', first_air_date: '' }
      ]
    }),
    '/3/search/movie': params => ({ page: 1, total_pages: 1, total_results: 1, results: [
      { id: 10, title: params.get('query') === 'dune' ? 'Dune' : 'Otra' }
    ] }),
    '/3/search/tv': () => ({ page: 1, total_pages: 0, total_results: 0, results: [] })
  });
  const internal = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const url = (await listen(t, gateway(internal, 'http://localhost:5173'))) + '/api/v1/media/search';

  const all = await fetch(url + '?query=%20dune%20&page=2');
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), {
    page: 2, total_pages: 500, total_results: 3,
    results: [
      summary({ id: 10, media_type: 'movie', title: 'Dune', release_date: '2021-09-15', genre_ids: [878, 12], poster_path: '/d.jpg' }),
      summary({ id: 20, media_type: 'tv', title: 'Dune: Prophecy' })
    ]
  });
  const sent = new URL(tmdb.calls[0], 'http://tmdb').searchParams;
  assert.equal(sent.get('query'), 'dune');
  assert.equal(sent.get('include_adult'), 'false');
  assert.equal(sent.get('language'), 'es-MX');

  // La segunda consulta equivalente se responde desde la caché.
  assert.equal((await fetch(url + '?query=dune&page=2')).status, 200);
  assert.equal(tmdb.calls.length, 1);

  const movies = await (await fetch(url + '?query=dune&media_type=movie&language=en-US')).json();
  assert.deepEqual(movies.results, [summary({ id: 10, media_type: 'movie', title: 'Dune' })]);
  assert.equal((await (await fetch(url + '?query=x&media_type=tv')).json()).total_results, 0);

  for (const query of ['', '?query=', '?query=%20%20', '?query=' + 'a'.repeat(101), '?query=a&page=0',
    '?query=a&page=501', '?query=a&page=1.5', '?query=a&media_type=person', '?query=a&query=b', '?query=a&sort=x']) {
    const response = await fetch(url + query);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});
