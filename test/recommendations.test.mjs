import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { media } from '../dist/media-service/src/server.js';
import { recommendations } from '../dist/recommendation-service/src/server.js';
import { fakeTmdb, listen } from './helpers.mjs';

const movie = (id, genre_ids, extra = {}) => ({ id, title: 'Película ' + id, genre_ids, vote_average: 7, ...extra });
const tv = (id, genre_ids, extra = {}) => ({ id, name: 'Serie ' + id, genre_ids, vote_average: 7, ...extra });

test('Recomendaciones por reglas con autorización y caché por usuario', async t => {
  // Supabase simulado: publica sus claves en /auth/v1/.well-known/jwks.json
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const supabase = await listen(t, (req, res) => req.url === '/auth/v1/.well-known/jwks.json'
    ? res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
    : res.writeHead(404).end());
  const sign = (sub, { key = privateKey, aud = 'authenticated', iss = supabase + '/auth/v1', exp = '1h' } = {}) =>
    new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject(sub).setAudience(aud).setIssuer(iss).setIssuedAt().setExpirationTime(exp).sign(key);

  // TMDB simulado detrás de un Media Service real.
  const tmdb = fakeTmdb({
    '/3/trending/all/day': () => ({ page: 1, results: [
      { media_type: 'movie', ...movie(4, [35]) }, { media_type: 'tv', ...tv(6, [10759]) }
    ] }),
    '/3/movie/popular': params => ({ page: Number(params.get('page')), total_pages: 2, total_results: 6,
      results: params.get('page') === '1'
        ? [movie(1, [28]), movie(2, [28, 12]), movie(3, [10749])]
        : [movie(4, [35]), movie(7, [18], { vote_average: 8 }), movie(8, [28], { vote_average: 6 })] }),
    '/3/tv/popular': params => ({ page: Number(params.get('page')), total_pages: 2, total_results: 3,
      results: params.get('page') === '1' ? [tv(5, [10759]), tv(6, [10759])] : [tv(9, [99])] }),
    '/3/movie/1': () => ({ id: 1, title: 'Favorita', genres: [{ id: 28, name: 'Acción' }] }),
    '/3/tv/5': () => ({ id: 5, name: 'Vista', genres: [{ id: 10759, name: 'Action & Adventure' }] })
  });
  const mediaOrigin = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));

  // Library simulada: responde según el token reenviado.
  const tokens = {};
  const data = {
    'user-1': {
      favorites: { results: [{ tmdb_id: 1, media_type: 'movie', id: 'uuid-1' }] },
      watchlist: [{ tmdb_id: 5, media_type: 'tv', status: 'watched' }, { tmdb_id: 404, media_type: 'movie' }]
    },
    'user-2': { favorites: [], watchlist: [] },
    'user-3': { favorites: 'roto' }
  };
  const libraryCalls = [];
  const libraryOrigin = await listen(t, (req, res) => {
    const user = tokens[req.headers.authorization?.slice(7)];
    libraryCalls.push(user + ' ' + req.url);
    if (!user) return res.writeHead(401).end();
    const body = data[user][req.url.split('/').pop()];
    if (body === undefined) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Ruta desconocida"}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });

  const base = await listen(t, recommendations({ mediaOrigin, libraryOrigin, auth: { supabaseUrl: supabase } }));
  const url = base + '/api/v1/recommendations';
  const as = async (sub, query = '', options) => {
    const token = await sign(sub, options);
    tokens[token] = sub;
    return fetch(url + query, { headers: { Authorization: 'Bearer ' + token } });
  };

  // Autorización: firma, emisor, audiencia y expiración.
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 401);
  assert.equal(typeof (await anonymous.json()).error, 'string');
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer abc' } })).status, 401);
  for (const options of [{ key: other.privateKey }, { aud: 'anon' }, { iss: 'https://otro/auth/v1' }, { exp: '-1m' }]) {
    assert.equal((await as('user-1', '', options)).status, 401, JSON.stringify(Object.keys(options)));
  }
  assert.equal(libraryCalls.length, 0);

  // Usuario con favoritos de acción y una serie vista.
  const first = await as('user-1');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  const body = await first.json();
  const ids = body.results.map(item => item.media_type + ':' + item.id);
  assert.deepEqual(body.based_on, { favorites: 1, watchlist: 2, progress: 0 });
  for (const excluded of ['movie:1', 'tv:5', 'movie:404']) assert.ok(!ids.includes(excluded), excluded);
  assert.deepEqual(ids.slice(0, 3).sort(), ['movie:2', 'movie:8', 'tv:6']);
  assert.ok(ids.indexOf('movie:3') > ids.indexOf('movie:2'));
  assert.equal(new Set(ids).size, ids.length);
  const tv6 = body.results.find(item => item.media_type === 'tv' && item.id === 6);
  assert.deepEqual(tv6.reasons, ['genres', 'trending', 'popular']);
  assert.ok(tv6.score > 0 && tv6.score <= 1);
  assert.equal(body.results.find(item => item.id === 7).reasons.includes('top_rated'), true);

  // Caché temporal por usuario: no vuelve a consultar Library aunque cambie el token.
  const before = libraryCalls.length;
  const again = await (await as('user-1', '?limit=2')).json();
  assert.deepEqual(again.results, body.results.slice(0, 2));
  assert.equal(libraryCalls.length, before);

  // Filtro por tipo e independencia entre usuarios (arranque en frío sin señales).
  const movies = await (await as('user-1', '?media_type=movie')).json();
  assert.ok(movies.results.every(item => item.media_type === 'movie'));
  const cold = await (await as('user-2')).json();
  assert.deepEqual(cold.based_on, { favorites: 0, watchlist: 0, progress: 0 });
  assert.ok(cold.results.some(item => item.id === 1 && item.media_type === 'movie'));
  assert.ok(cold.results.every(item => !item.reasons.includes('genres')));

  // Validación y fallos de Library.
  for (const query of ['?limit=0', '?limit=41', '?media_type=person', '?page=1']) {
    assert.equal((await as('user-1', query)).status, 400, query);
  }
  const broken = await as('user-3');
  assert.equal(broken.status, 502);
  assert.deepEqual(await broken.json(), { error: 'Respuesta inválida de Library Service' });
});
