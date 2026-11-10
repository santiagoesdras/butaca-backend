import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gateway } from '../dist/api-gateway/src/server.js';
import { library } from '../dist/library-service/src/server.js';
import { listen } from './helpers.mjs';

test('Gateway → Library: JWT, CORS, cuerpo, respuestas vacías y aislamiento', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'integration', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const sign = sub => new SignJWT({ sub }).setProtectedHeader({ alg: 'ES256', kid: 'integration' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const users = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const authorization = await Promise.all(users.map(async user => ({ Authorization: 'Bearer ' + await sign(user) })));
  const rows = new Map();
  let operations = 0;
  const store = {
    async list(user) { operations++; return [...rows].filter(([key]) => key.startsWith(user)).map(([, row]) => row); },
    async add(user, ref) {
      operations++;
      const key = `${user}:${ref.media_type}:${ref.tmdb_id}`;
      if (!rows.has(key)) rows.set(key, { ...ref, status: 'pending', created_at: '2026-11-10T00:00:00.000Z' });
      return rows.get(key);
    },
    async remove(user, ref) { operations++; rows.delete(`${user}:${ref.media_type}:${ref.tmdb_id}`); }
  };
  const auth = { supabaseUrl: issuer };
  const internal = await listen(t, library(store, auth));
  const frontend = 'http://localhost:5173';
  const base = await listen(t, gateway(internal, frontend, auth, undefined, 7000, internal));
  const path = '/api/v1/library/watchlist';
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal(operations, 0);
  const preflight = await fetch(base + path + '/movie/42', { method: 'OPTIONS', headers: {
    Origin: frontend, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type'
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
  const added = await fetch(base + path + '/movie/42', { method: 'PUT', headers: authorization[0] });
  assert.equal(added.status, 200);
  assert.equal(added.headers.get('cache-control'), 'private, no-store');
  assert.equal((await added.json()).tmdb_id, 42);
  assert.deepEqual(await (await fetch(base + path, { headers: authorization[1] })).json(), { results: [] });
  assert.equal((await fetch(base + path + '/movie/42', { method: 'DELETE', headers: authorization[1] })).status, 204);
  assert.equal(rows.size, 1);
  const invalid = await fetch(base + path + '/movie/42', { method: 'PUT', headers: {
    ...authorization[0], 'Content-Type': 'application/json'
  }, body: JSON.stringify({ profileId: users[1] }) });
  assert.equal(invalid.status, 400, 'el Gateway conserva el cuerpo y Library rechaza identidad inyectada');
  const tooLarge = await fetch(base + path + '/movie/42', { method: 'PUT', headers: {
    ...authorization[0], 'Content-Type': 'application/json'
  }, body: JSON.stringify({ value: 'x'.repeat(1100) }) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await fetch(base + path + '?profileId=x', { headers: authorization[0] })).status, 400);
  assert.equal((await fetch(base + '/api/v1/library/internal', { headers: authorization[0] })).status, 404);
  const removed = await fetch(base + path + '/movie/42', { method: 'DELETE', headers: authorization[0] });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
  assert.equal(rows.size, 0);
  const missing = await listen(t, gateway(internal, frontend, auth));
  assert.equal((await fetch(missing + path, { headers: authorization[0] })).status, 503);
});
