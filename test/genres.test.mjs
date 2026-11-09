import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { fakeTmdb, listen } from './helpers.mjs';

test('Géneros de películas y series', async t => {
  const english = params => params.get('language') === 'en-US';
  const tmdb = fakeTmdb({
    '/3/genre/movie/list': params => ({ genres: english(params)
      ? [{ id: 28, name: 'Action' }, { id: 18, name: 'Drama' }]
      : [{ id: 28, name: 'Acción' }, { id: 18, name: 'Drama' }, { id: 'x', name: 'Inválido' }] }),
    '/3/genre/tv/list': () => ({ genres: [{ id: 18, name: 'Drama' }, { id: 10759, name: 'Action & Adventure' }] })
  });
  const internal = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const url = (await listen(t, gateway(internal, 'http://localhost:5173'))) + '/api/v1/media/genres';

  assert.deepEqual(await (await fetch(url)).json(), { genres: [
    { id: 28, name: 'Acción', media_types: ['movie'] },
    { id: 10759, name: 'Action & Adventure', media_types: ['tv'] },
    { id: 18, name: 'Drama', media_types: ['movie', 'tv'] }
  ] });
  assert.deepEqual(await (await fetch(url + '?media_type=movie&language=en-US')).json(), { genres: [
    { id: 28, name: 'Action', media_types: ['movie'] },
    { id: 18, name: 'Drama', media_types: ['movie'] }
  ] });
  // Cada catálogo (tipo + idioma) se consulta una sola vez.
  await fetch(url + '?media_type=tv');
  await fetch(url + '?media_type=movie');
  assert.equal(tmdb.calls.length, 3);
  assert.ok(tmdb.calls.every(call => call.includes('language=')));

  for (const query of ['?media_type=person', '?language=es', '?page=1']) {
    assert.equal((await fetch(url + query)).status, 400, query);
  }
});
