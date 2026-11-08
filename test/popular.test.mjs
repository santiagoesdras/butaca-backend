import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { fakeTmdb, listen, summary } from './helpers.mjs';

test('Contenido popular paginado', async t => {
  const tmdb = fakeTmdb({
    '/3/movie/popular': params => ({
      page: Number(params.get('page')), total_pages: 40, total_results: 800,
      results: [{ id: 1, title: 'P1', genre_ids: [28] }, { id: 2, title: 'P2' }, { id: 3, title: 'P3' }]
    }),
    '/3/tv/popular': params => params.get('page') === '7' ? { status: 500 } : ({
      page: Number(params.get('page')), total_pages: 30, total_results: 600,
      results: [{ id: 1, name: 'S1', first_air_date: '2020-02-02' }]
    })
  });
  const internal = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const url = (await listen(t, gateway(internal, 'http://localhost:5173'))) + '/api/v1/media/popular';

  const movies = await (await fetch(url + '?media_type=movie&page=2')).json();
  assert.deepEqual(movies, { page: 2, total_pages: 40, total_results: 800, results: [
    summary({ id: 1, media_type: 'movie', title: 'P1', genre_ids: [28] }),
    summary({ id: 2, media_type: 'movie', title: 'P2' }),
    summary({ id: 3, media_type: 'movie', title: 'P3' })
  ] });

  // `all` intercala tipos, conserva el id repetido con distinto media_type y reutiliza la caché de movie.
  const all = await (await fetch(url + '?page=2')).json();
  assert.equal(all.total_pages, 30);
  assert.equal(all.total_results, 1400);
  assert.deepEqual(all.results.map(r => r.media_type + ':' + r.id), ['movie:1', 'tv:1', 'movie:2', 'movie:3']);
  assert.equal(tmdb.calls.filter(call => call.startsWith('/3/movie/popular')).length, 1);

  assert.equal((await fetch(url + '?media_type=tv&page=7')).status, 502);
  for (const query of ['?page=0', '?page=501', '?media_type=person', '?region=MX']) {
    assert.equal((await fetch(url + query)).status, 400, query);
  }
});
