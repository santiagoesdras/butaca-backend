import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gateway } from '../dist/api-gateway/src/server.js';
import { library } from '../dist/library-service/src/server.js';
import { media } from '../dist/media-service/src/server.js';
import { recommendations } from '../dist/recommendation-service/src/server.js';
import { fakeTmdb, listen } from './helpers.mjs';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';

// Almacenamiento en memoria con la misma interfaz que el de Prisma, separado por usuario.
function memoryStore(extra = {}) {
  const rows = new Map();
  const calls = [];
  return {
    rows, calls,
    async list(user) { calls.push(user); return [...rows].filter(([key]) => key.startsWith(user + ':')).map(([, row]) => row); },
    async add(user, ref) {
      calls.push(user);
      const key = `${user}:${ref.media_type}:${ref.tmdb_id}`;
      if (!rows.has(key)) rows.set(key, { ...ref, ...extra, created_at: '2026-11-10T00:00:00.000Z' });
      return rows.get(key);
    },
    async remove(user, ref) { calls.push(user); rows.delete(`${user}:${ref.media_type}:${ref.tmdb_id}`); }
  };
}

test('Favoritos: Gateway → Library con JWT, aislamiento y validación; Recomendaciones los consume', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'favorites', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const sign = sub => new SignJWT({ sub }).setProtectedHeader({ alg: 'ES256', kid: 'favorites' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const headers = { Authorization: 'Bearer ' + await sign(alice) };
  const bobHeaders = { Authorization: 'Bearer ' + await sign(bob) };

  const favorites = memoryStore();
  const watchlist = memoryStore({ status: 'pending' });
  const auth = { supabaseUrl: issuer };
  const internal = await listen(t, library(watchlist, auth, undefined, favorites));

  // Media real sobre un TMDB simulado, para comprobar que Recomendaciones ya no falla por favoritos.
  const tmdb = fakeTmdb({
    '/3/trending/all/day': () => ({ page: 1, results: [] }),
    '/3/movie/popular': params => ({ page: Number(params.get('page')), total_pages: 1, total_results: 3, results: params.get('page') === '1'
      ? [{ id: 550, title: 'Favorita', genre_ids: [18] }, { id: 7, title: 'Drama', genre_ids: [18] }, { id: 8, title: 'Comedia', genre_ids: [35] }]
      : [] }),
    '/3/tv/popular': () => ({ page: 1, total_pages: 1, total_results: 0, results: [] }),
    '/3/movie/550': () => ({ id: 550, title: 'Favorita', genres: [{ id: 18, name: 'Drama' }] })
  });
  const mediaOrigin = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const recommendationOrigin = await listen(t, recommendations({ mediaOrigin, libraryOrigin: internal, auth }));

  const frontend = 'http://localhost:5173';
  const base = await listen(t, gateway(mediaOrigin, frontend, auth, recommendationOrigin, 7000, internal));
  const path = '/api/v1/library/favorites';

  // Autenticación obligatoria, antes de tocar el almacenamiento.
  const anonymous = await fetch(base + path);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
  assert.equal(favorites.calls.length, 0);

  const preflight = await fetch(base + path + '/movie/550', { method: 'OPTIONS', headers: {
    Origin: frontend, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization'
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);

  // Agregar es idempotente y no lleva cuerpo.
  const put = () => fetch(base + path + '/movie/550', { method: 'PUT', headers });
  const added = await put();
  assert.equal(added.status, 200);
  assert.equal(added.headers.get('cache-control'), 'private, no-store');
  const entry = await added.json();
  assert.deepEqual(entry, { tmdb_id: 550, media_type: 'movie', created_at: '2026-11-10T00:00:00.000Z' });
  assert.deepEqual(await (await put()).json(), entry);
  assert.equal((await fetch(base + path + '/tv/550', { method: 'PUT', headers })).status, 200);
  assert.equal(favorites.rows.size, 2, 'película y serie con el mismo ID son favoritos distintos');
  assert.equal(watchlist.rows.size, 0, 'favoritos y watchlist son listas independientes');

  // Cada usuario ve y borra solo lo suyo.
  assert.deepEqual(await (await fetch(base + path, { headers: bobHeaders })).json(), { results: [] });
  assert.equal((await fetch(base + path + '/movie/550', { method: 'DELETE', headers: bobHeaders })).status, 204);
  assert.equal(favorites.rows.size, 2);
  assert.equal((await (await fetch(base + path, { headers })).json()).results.length, 2);

  // Validación de la referencia, del cuerpo y de la query.
  for (const suffix of ['/movie/0', '/movie/01', '/movie/2147483648', '/person/42']) {
    assert.equal((await fetch(base + path + suffix, { method: 'PUT', headers })).status, 400, suffix);
  }
  const injected = await fetch(base + path + '/movie/550', { method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: bob }) });
  assert.equal(injected.status, 400, 'no se acepta identidad enviada por el cliente');
  assert.equal((await fetch(base + path + '?user_id=' + bob, { headers })).status, 400);

  // Recomendaciones ya obtiene favoritos de Library: excluye el favorito y prioriza su género.
  const recommended = await fetch(base + '/api/v1/recommendations?media_type=movie', { headers });
  assert.equal(recommended.status, 200);
  const body = await recommended.json();
  assert.deepEqual(body.based_on, { favorites: 2, watchlist: 0, progress: 0 });
  assert.deepEqual(body.results.map(item => item.id), [7, 8]);
  assert.deepEqual(body.results[0].reasons.includes('genres'), true);

  // Eliminar responde 204 sin cuerpo, también si ya no existía.
  for (let i = 0; i < 2; i++) {
    const removed = await fetch(base + path + '/movie/550', { method: 'DELETE', headers });
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), '');
  }
  assert.deepEqual((await (await fetch(base + path, { headers })).json()).results.map(r => r.media_type), ['tv']);
});
