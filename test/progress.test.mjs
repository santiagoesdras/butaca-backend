import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { library } from '../dist/library-service/src/server.js';
import { progressInput } from '../dist/library-service/src/progress.js';
import { gateway } from '../dist/api-gateway/src/server.js';
import { listen } from './helpers.mjs';

test('Progreso: validación de estado, tiempos y separación entre películas y series', () => {
  const movie = { media_type: 'movie', tmdb_id: 42 };
  const tv = { ...movie, media_type: 'tv' };
  for (const status of ['in_progress', 'completed', 'on_hold', 'dropped']) {
    assert.deepEqual(progressInput({ status }, movie), { status, position_seconds: null, duration_seconds: null });
  }
  assert.equal(progressInput({ status: 'in_progress', position_seconds: 10, duration_seconds: 20 }, movie).position_seconds, 10);
  for (const body of [undefined, [], null, {}, { status: ['completed'] }, { status: 'watched' },
    { status: 'completed', profile_id: 'other' }, { status: 'in_progress', position_seconds: -1 },
    { status: 'in_progress', position_seconds: '10' }, { status: 'in_progress', duration_seconds: 0 },
    { status: 'in_progress', position_seconds: 1.5 }, { status: 'in_progress', duration_seconds: 2147483648 },
    { status: 'in_progress', position_seconds: 21, duration_seconds: 20 }]) {
    assert.throws(() => progressInput(body, movie), error => error.status === 400);
  }
  assert.throws(() => progressInput({ status: 'in_progress', position_seconds: 0 }, tv), error => error.status === 400);
});

test('Gateway → Progreso: actualizaciones, episodios, aislamiento y validación', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'progress', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const users = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const headers = await Promise.all(users.map(async sub => ({ Authorization: 'Bearer ' + await new SignJWT({ sub })
    .setProtectedHeader({ alg: 'ES256', kid: 'progress' }).setIssuer(issuer + '/auth/v1')
    .setAudience('authenticated').setExpirationTime('1h').sign(privateKey) })));
  const rows = new Map();
  const key = (user, ref) => `${user}:${ref.media_type}:${ref.tmdb_id}`;
  const make = (ref, input = { status: 'in_progress', position_seconds: null, duration_seconds: null }) => ({
    ...ref, ...input, updated_at: '2026-11-10T00:00:00.000Z', episodes: []
  });
  const progress = {
    async list(user) { return [...rows].filter(([id]) => id.startsWith(user)).map(([, item]) => item); },
    async set(user, ref, input) {
      const id = key(user, ref);
      rows.set(id, { ...make(ref, input), episodes: rows.get(id)?.episodes ?? [] });
      return rows.get(id);
    },
    async markEpisode(user, ref, episode) {
      const id = key(user, ref);
      if (!rows.has(id)) rows.set(id, make(ref));
      const row = rows.get(id);
      if (!row.episodes.some(item => item.season === episode.season && item.episode === episode.episode)) {
        row.episodes.push({ ...episode, watched_at: '2026-11-10T00:00:00.000Z' });
      }
      return row;
    },
    async removeEpisode(user, ref, episode) {
      const row = rows.get(key(user, ref));
      if (row) row.episodes = row.episodes.filter(item => item.season !== episode.season || item.episode !== episode.episode);
    }
  };
  const auth = { supabaseUrl: issuer };
  const store = { async list() { return []; }, async add() { throw new Error('not used'); }, async remove() {} };
  const internal = await listen(t, library(store, auth, progress));
  const base = await listen(t, gateway(internal, 'http://localhost:5173', auth, undefined, 7000, internal));
  const path = '/api/v1/library/progress';
  assert.equal((await fetch(base + path)).status, 401);
  const put = (suffix, body, user = 0) => fetch(base + path + suffix, { method: 'PUT',
    headers: { ...headers[user], 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await put('/movie/42', { status: 'in_progress', position_seconds: 60, duration_seconds: 100 });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).position_seconds, 60);
  assert.equal((await put('/movie/42', { status: 'completed', position_seconds: 100, duration_seconds: 100 })).status, 200);
  assert.equal(rows.size, 1);
  assert.deepEqual(await (await fetch(base + path, { headers: headers[1] })).json(), { results: [] });
  assert.equal((await (await fetch(base + path, { headers: headers[0] })).json()).results[0].status, 'completed');
  const episode = '/tv/99/episodes/0/1';
  for (let i = 0; i < 2; i++) assert.equal((await put(episode, {})).status, 200);
  let tv = rows.get(key(users[0], { media_type: 'tv', tmdb_id: 99 }));
  assert.equal(tv.episodes.length, 1);
  assert.equal(tv.status, 'in_progress', 'un episodio no completa la serie');
  assert.equal((await fetch(base + path + episode, { method: 'DELETE', headers: headers[1] })).status, 204);
  assert.equal(tv.episodes.length, 1, 'otro usuario no elimina un episodio');
  assert.equal((await put('/tv/99', { status: 'on_hold' })).status, 200);
  tv = rows.get(key(users[0], { media_type: 'tv', tmdb_id: 99 }));
  assert.equal(tv.episodes.length, 1, 'actualizar estado conserva los episodios');
  for (const suffix of ['/tv/99/episodes/-1/1', '/tv/99/episodes/1/0', '/tv/99/episodes/01/1',
    '/tv/99/episodes/2147483648/1', '/person/42', '/movie/0']) {
    assert.equal((await put(suffix, { status: 'in_progress' })).status, 400);
  }
  assert.equal((await put('/movie/42', { status: 'completed', user_id: users[1] })).status, 400);
  assert.equal((await put('/tv/99', { status: 'in_progress', position_seconds: 1 })).status, 400);
  assert.equal((await put(episode, { profileId: users[1] })).status, 400);
  assert.equal((await fetch(base + path + '?user_id=x', { headers: headers[0] })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await fetch(base + path + episode, { method: 'DELETE', headers: headers[0] })).status, 204);
  assert.equal(tv.episodes.length, 0);
});
