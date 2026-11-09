import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { fakeTmdb, listen, summary } from './helpers.mjs';

// Catálogo simulado de TMDB: `pages` listas de resultados; fuera de rango responde una página vacía.
const catalog = (pages, item) => params => {
  const page = Number(params.get('page'));
  const results = (pages[page - 1] ?? []).map(item);
  return { page, total_pages: pages.length, total_results: pages.flat().length, results };
};

test('Contenido popular paginado', async t => {
  const movies = [[1, 2, 3], [4, 5], [6]];
  const tmdb = fakeTmdb({
    '/3/movie/popular': catalog(movies, id => ({ id, title: 'P' + id, genre_ids: id === 1 ? [28] : [] })),
    // En inglés el catálogo de series está vacío; en la página 7 TMDB falla.
    '/3/tv/popular': params => params.get('page') === '7' ? { status: 500 }
      : catalog(params.get('language') === 'en-US' ? [] : [[1]], id => ({ id, name: 'S' + id, first_air_date: '2020-02-02' }))(params)
  });
  const internal = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const url = (await listen(t, gateway(internal, 'http://localhost:5173'))) + '/api/v1/media/popular';
  const get = async query => (await fetch(url + query)).json();
  const ids = body => body.results.map(r => r.media_type + ':' + r.id);

  assert.deepEqual(await get('?media_type=movie'), { page: 1, total_pages: 3, total_results: 6, results: [
    summary({ id: 1, media_type: 'movie', title: 'P1', genre_ids: [28] }),
    summary({ id: 2, media_type: 'movie', title: 'P2' }),
    summary({ id: 3, media_type: 'movie', title: 'P3' })
  ] });

  // `all` intercala tipos y conserva el mismo id con distinto media_type.
  const first = await get('?page=1');
  assert.deepEqual(ids(first), ['movie:1', 'tv:1', 'movie:2', 'movie:3']);
  assert.equal(first.total_pages, 3, 'se recorre hasta el catálogo más largo');
  assert.equal(first.total_results, 7);

  // Las series se agotan en la página 1: las siguientes solo traen películas, sin pedir páginas de series inexistentes.
  assert.deepEqual(ids(await get('?page=2')), ['movie:4', 'movie:5']);
  const last = await get('?page=3');
  assert.deepEqual(ids(last), ['movie:6']);
  assert.equal(last.total_pages, 3);
  assert.deepEqual(ids(await get('?page=4')), []);
  assert.ok(!tmdb.calls.some(call => call.startsWith('/3/tv/popular?page=2')));

  // Un catálogo vacío no anula al otro (antes respondía total_pages: 0 con contenido disponible).
  const english = await get('?language=en-US');
  assert.equal(english.total_pages, 3);
  assert.equal(english.total_results, 6);
  assert.deepEqual(ids(english), ['movie:1', 'movie:2', 'movie:3']);
  assert.deepEqual(ids(await get('?page=3&language=en-US')), ['movie:6']);

  // La página 1 de cada tipo se reutiliza desde la caché.
  assert.equal(tmdb.calls.filter(call => call.startsWith('/3/movie/popular?page=1&language=es-MX')).length, 1);

  assert.equal((await fetch(url + '?media_type=tv&page=7')).status, 502);
  for (const query of ['?page=0', '?page=501', '?media_type=person', '?region=MX']) {
    assert.equal((await fetch(url + query)).status, 400, query);
  }
});
