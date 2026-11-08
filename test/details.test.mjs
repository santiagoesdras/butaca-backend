import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { fakeTmdb, listen } from './helpers.mjs';

test('Detalle de películas y series', async t => {
  const tmdb = fakeTmdb({
    '/3/movie/550': params => ({
      id: 550, title: params.get('language') === 'en-US' ? 'Fight Club' : 'El club de la pelea',
      original_title: 'Fight Club', overview: 'Sinopsis', tagline: '', status: 'Released',
      poster_path: '/p.jpg', backdrop_path: null, release_date: '1999-10-15',
      genres: [{ id: 18, name: 'Drama' }, { id: 'x' }], vote_average: 8.4, vote_count: 30000, runtime: 139,
      budget: 63000000
    }),
    '/3/tv/1399': () => ({
      id: 1399, name: 'Juego de tronos', original_name: 'Game of Thrones', first_air_date: '2011-04-17',
      genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }], episode_run_time: [], number_of_seasons: 8,
      number_of_episodes: 73, seasons: [{ season_number: 0, name: 'Especiales', episode_count: 14, air_date: null }]
    }),
    '/3/movie/12': () => ({ id: 13, title: 'Otro' })
  });
  const internal = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const base = (await listen(t, gateway(internal, 'http://localhost:5173'))) + '/api/v1/media';

  const movie = await fetch(base + '/movie/550');
  assert.equal(movie.status, 200);
  assert.deepEqual(await movie.json(), {
    id: 550, media_type: 'movie', title: 'El club de la pelea', original_title: 'Fight Club',
    overview: 'Sinopsis', tagline: null, status: 'Released', poster_path: '/p.jpg', backdrop_path: null,
    release_date: '1999-10-15', genres: [{ id: 18, name: 'Drama' }], vote_average: 8.4, vote_count: 30000,
    runtime: 139
  });
  assert.equal((await (await fetch(base + '/movie/550?language=en-US')).json()).title, 'Fight Club');
  await fetch(base + '/movie/550');
  assert.equal(tmdb.calls.filter(call => call.startsWith('/3/movie/550')).length, 2);

  assert.deepEqual(await (await fetch(base + '/tv/1399')).json(), {
    id: 1399, media_type: 'tv', title: 'Juego de tronos', original_title: 'Game of Thrones', overview: '',
    tagline: null, status: null, poster_path: null, backdrop_path: null, release_date: '2011-04-17',
    genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }], vote_average: null, vote_count: null, runtime: null,
    number_of_seasons: 8, number_of_episodes: 73,
    seasons: [{ season_number: 0, name: 'Especiales', episode_count: 14, air_date: null, poster_path: null }]
  });

  const missing = await fetch(base + '/movie/404');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Contenido no encontrado' });
  assert.equal((await fetch(base + '/movie/12')).status, 502);

  for (const path of ['/person/1', '/movie/0', '/movie/abc', '/movie/1.5', '/movie/01', '/tv/12345678901',
    '/movie/550?page=1', '/../health', '/%2E%2E/1']) {
    const response = await fetch(base + path);
    assert.ok([400, 404].includes(response.status), path + ' → ' + response.status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await fetch(base + '/person/1')).status, 400);
  assert.deepEqual(await (await fetch(base + '/x.y/1')).json(), { error: 'Ruta inválida' });
});
