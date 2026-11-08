import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { fakeTmdb, listen, summary } from './helpers.mjs';

test('Gateway → Media → proveedor HTTP', async t => {
  let mode = 'ok';
  const tmdb = fakeTmdb({
    '/3/trending/all/day': () => {
      if (mode === 'slow') return undefined;
      if (mode === 'limited') return { status: 429, headers: { 'Retry-After': '12' } };
      return { page: 1, total_pages: 1000, results: [
        { media_type: 'tv', id: 2, name: 'Serie', first_air_date: '2024-01-01', genre_ids: [18] },
        { media_type: 'person' },
        { media_type: 'movie', id: 3, title: 'Película', vote_average: 7.5 }
      ] };
    }
  });
  const provider = await listen(t, tmdb.handler);
  const internal = await listen(t, media('prueba', provider, 500));
  const origin = 'http://localhost:5173';
  const external = await listen(t, gateway(internal, origin));
  for (const base of [internal, external]) {
    assert.deepEqual(await (await fetch(base + '/health/live')).json(), { status: 'ok' });
  }
  const url = external + '/api/v1/media/trending';
  const responses = await Promise.all([fetch(url, { headers: { Origin: origin } }), fetch(url)]);
  assert.equal(responses[0].headers.get('access-control-allow-origin'), origin);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { page: 1, results: [
      summary({ media_type: 'tv', id: 2, title: 'Serie', release_date: '2024-01-01', genre_ids: [18] }),
      summary({ media_type: 'movie', id: 3, title: 'Película', vote_average: 7.5 })
    ] });
  }
  assert.equal((await fetch(url)).status, 200);
  const bad = await fetch(url + '?language=bad');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /language/);
  assert.equal((await fetch(url + '?page=2')).status, 400);
  assert.equal(tmdb.calls.length, 1);
  mode = 'limited';
  const limited = await fetch(url + '?language=en-US');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '12');
  mode = 'slow';
  assert.equal((await fetch(url + '?language=en-US')).status, 504);
  mode = 'ok';
  assert.equal((await fetch(url + '?language=en-US')).status, 200);
});
