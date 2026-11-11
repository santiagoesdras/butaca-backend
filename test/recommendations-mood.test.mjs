import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { media } from '../dist/media-service/src/server.js';
import { recommendations } from '../dist/recommendation-service/src/server.js';
import { fakeTmdb, listen } from './helpers.mjs';

const secret = 'secreto-de-prueba';
const supabaseUrl = 'http://supabase.test';
const sign = sub => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setAudience('authenticated')
  .setIssuer(supabaseUrl + '/auth/v1').setExpirationTime('5m').sign(new TextEncoder().encode(secret));
const movie = (id, genre_ids) => ({ id, title: 'Película ' + id, genre_ids, vote_average: 7 });

async function setup(t, { library, tmdbRoutes = {}, budget, timeout }) {
  const tmdb = fakeTmdb({
    '/3/trending/all/day': () => ({ page: 1, results: [] }),
    '/3/movie/popular': params => ({ page: Number(params.get('page')), total_pages: 1, total_results: 4, results: params.get('page') === '1'
      ? [movie(1, [27, 53]), movie(2, [35, 10751]), movie(3, [28]), movie(4, [18])] : [] }),
    '/3/tv/popular': () => ({ page: 1, total_pages: 1, total_results: 0, results: [] }),
    ...tmdbRoutes
  });
  const mediaOrigin = await listen(t, media('prueba', await listen(t, tmdb.handler), 500));
  const libraryOrigin = await listen(t, library);
  const base = await listen(t, recommendations({ mediaOrigin, libraryOrigin, auth: { supabaseUrl, jwtSecret: secret }, budget, timeout }));
  return async (sub, query = '') => fetch(base + '/api/v1/recommendations' + query, { headers: { Authorization: 'Bearer ' + await sign(sub) } });
}

const json = body => (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

test('Recomendaciones por emoción', async t => {
  let libraryCalls = 0;
  const get = await setup(t, { library: (req, res) => { libraryCalls++; json({ results: [] })(req, res); } });

  // Sin emoción, arranque en frío: manda la popularidad (el título 1, de terror, va primero).
  const neutral = await (await get('u1', '?media_type=movie')).json();
  assert.equal(neutral.mood, null);
  assert.equal(neutral.results[0].id, 1);

  // Con miedo se evita el terror y se priorizan comedia y familia.
  const fear = await (await get('u1', '?media_type=movie&mood=FEAR')).json();
  assert.equal(fear.mood, 'FEAR');
  assert.equal(fear.results[0].id, 2);
  assert.deepEqual(fear.results[0].reasons.includes('mood'), true);
  assert.equal(fear.results.at(-1).id, 1, 'el terror queda al final');
  assert.ok(!fear.results.find(item => item.id === 1).reasons.includes('mood'));

  // Calma favorece drama; cada emoción se guarda en caché por separado.
  const calm = await (await get('u1', '?media_type=movie&mood=CALM')).json();
  assert.equal(calm.results[0].id, 4);
  const callsBefore = libraryCalls;
  await get('u1', '?media_type=movie&mood=CALM');
  assert.equal(libraryCalls, callsBefore, 'la misma emoción se responde desde la caché');

  for (const query of ['?mood=fear', '?mood=FEARFUL', '?mood=', '?mood=SAD&mood=HAPPY']) {
    const response = await get('u1', query);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /mood/);
  }
});

test('Recomendaciones degradan señales y respetan el presupuesto de tiempo', async t => {
  // El detalle de un título semilla falla (500) y el de otro tarda más que el presupuesto:
  // ambas señales se omiten y la recomendación responde igual.
  const library = (req, res) => json({ results: req.url.endsWith('/favorites')
    ? [{ tmdb_id: 500, media_type: 'movie' }, { tmdb_id: 501, media_type: 'movie' }, { tmdb_id: 502, media_type: 'movie' }]
    : [] })(req, res);
  const get = await setup(t, {
    library, budget: 800,
    tmdbRoutes: {
      '/3/movie/500': () => ({ status: 500 }),
      '/3/movie/501': () => undefined, // nunca responde
      '/3/movie/502': () => ({ id: 502, title: 'Acción', genres: [{ id: 28, name: 'Acción' }] })
    }
  });
  const started = performance.now();
  const response = await get('u2', '?media_type=movie');
  const elapsed = performance.now() - started;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.based_on.favorites, 3);
  assert.equal(body.results[0].id, 3, 'la única señal válida (acción) sigue influyendo');
  assert.ok(elapsed < 1500, `responde dentro del presupuesto (${Math.round(elapsed)} ms)`);

  // Si Library no responde, se agota el presupuesto y se devuelve 504 antes que el Gateway (7 s).
  const slow = await setup(t, { library: () => {}, budget: 300 });
  const timedOut = performance.now();
  const late = await slow('u3');
  assert.equal(late.status, 504);
  assert.ok(performance.now() - timedOut < 1500);
});
