import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { library } from '../dist/library-service/src/server.js';
import { listen } from './helpers.mjs';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';

test('Watchlist HTTP: JWT, aislamiento, validación e idempotencia', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'watchlist', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const sign = (sub, options = {}, key = privateKey) => new SignJWT({
    sub, aud: 'authenticated', iss: issuer + '/auth/v1', exp: Math.floor(Date.now() / 1000) + 300, ...options
  }).setProtectedHeader({ alg: 'ES256', kid: 'watchlist' }).sign(key);
  const rows = new Map();
  const calls = [];
  let failure;
  const store = {
    async list(user) {
      calls.push(user);
      if (failure) throw failure;
      return [...rows].filter(([key]) => key.startsWith(user + ':')).map(([, row]) => row);
    },
    async add(user, ref) {
      calls.push(user);
      if (failure) throw failure;
      const key = `${user}:${ref.media_type}:${ref.tmdb_id}`;
      if (!rows.has(key)) rows.set(key, { ...ref, status: 'pending', created_at: '2026-11-10T00:00:00.000Z' });
      return rows.get(key);
    },
    async remove(user, ref) { calls.push(user); rows.delete(`${user}:${ref.media_type}:${ref.tmdb_id}`); }
  };
  const base = await listen(t, library(store, { supabaseUrl: issuer }));
  const path = '/api/v1/library/watchlist';
  const headers = { Authorization: 'Bearer ' + await sign(alice) };
  const bobHeaders = { Authorization: 'Bearer ' + await sign(bob) };
  assert.equal((await fetch(base + '/health/live')).status, 200);
  for (const token of [undefined, 'invalid', await sign(alice, { exp: 1 }), await sign(alice, {}, other.privateKey),
    await sign(alice, { aud: 'anon' }), await sign(alice, { iss: 'https://wrong-project' }), await sign('fake-user')]) {
    const rejected = await fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('www-authenticate'), 'Bearer');
    assert.equal(rejected.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(calls.length, 0, 'ningún acceso al almacenamiento antes de verificar el JWT');
  const put = () => fetch(base + path + '/movie/42', { method: 'PUT', headers });
  const added = await put();
  assert.equal(added.status, 200);
  assert.equal(added.headers.get('cache-control'), 'private, no-store');
  const original = await added.json();
  assert.deepEqual(await (await put()).json(), original);
  assert.equal(rows.size, 1);
  assert.deepEqual(await (await fetch(base + path, { headers: bobHeaders })).json(), { results: [] });
  await fetch(base + path + '/movie/42', { method: 'DELETE', headers: bobHeaders });
  assert.equal(rows.size, 1, 'otro usuario no puede borrar el registro');
  assert.deepEqual(await (await fetch(base + path, { headers: { ...headers, 'X-User-Id': bob } })).json(), { results: [original] });
  assert.equal(calls.at(-1), alice);
  assert.equal((await fetch(base + path + '/tv/42', { method: 'PUT', headers })).status, 200);
  assert.equal(rows.size, 2, 'película y serie con el mismo ID son contenidos distintos');
  for (const suffix of ['/movie/0', '/movie/-1', '/movie/1.5', '/movie/2147483648', '/movie/01', '/person/42']) {
    assert.equal((await fetch(base + path + suffix, { method: 'PUT', headers })).status, 400);
  }
  for (const body of ['{"profileId":"' + bob + '"}', '{"status":"completed"}', '[1]', 'null', '{bad']) {
    assert.equal((await fetch(base + path + '/movie/42', {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body
    })).status, 400);
  }
  assert.equal((await fetch(base + path + '?user_id=' + bob, { headers })).status, 400);
  assert.equal((await fetch(base + path + '/movie/42', {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(1100) })
  })).status, 413);
  assert.equal((await fetch(base + '/api/v1/library/favorites', { headers })).status, 404);
  for (let i = 0; i < 2; i++) {
    const removed = await fetch(base + path + '/movie/42', { method: 'DELETE', headers });
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), '');
  }
  failure = Object.assign(new Error('detalle privado de postgres'), { code: 'P2003' });
  assert.equal((await put()).status, 409);
  failure = new Error('postgres://secret');
  const unavailable = await fetch(base + path, { headers });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'Library no disponible' });
  assert.equal((await fetch(base + '/health/live')).status, 200, 'salud de proceso independiente de DB');
});
