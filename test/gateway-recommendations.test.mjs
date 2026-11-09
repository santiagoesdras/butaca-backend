import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gateway } from '../dist/api-gateway/src/server.js';
import { listen } from './helpers.mjs';

test('Gateway enruta recomendaciones autenticadas y controla errores del servicio', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'gateway', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const token = await new SignJWT({ sub: 'user-1' }).setProtectedHeader({ alg: 'ES256', kid: 'gateway' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const calls = [];
  let status = 200;
  let hang = false;
  const result = { results: [{ id: 42, media_type: 'movie' }], based_on: { favorites: 1, watchlist: 0, progress: 0 } };
  const service = await listen(t, (req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization, user: req.headers['x-user-id'] });
    if (hang) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '12' } : {}) });
    res.end(JSON.stringify(status === 200 ? result : { error: 'Error simulado' }));
  });
  const base = await listen(t, gateway(service, 'http://localhost:5173', { supabaseUrl: issuer }, service, 100));
  const path = '/api/v1/recommendations?media_type=movie&limit=5&language=es-MX';
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + path, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal(calls.length, 0, 'rechaza tokens antes de contactar al servicio');
  const headers = { Authorization: 'Bearer ' + token, 'X-User-Id': 'spoofed' };
  const response = await fetch(base + path, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls[0], { url: path, authorization: headers.Authorization, user: undefined });
  for (status of [400, 401, 403, 429, 503, 504, 404, 500]) {
    const failed = await fetch(base + path, { headers });
    assert.equal(failed.status, [404, 500].includes(status) ? 502 : status);
    assert.equal(failed.headers.get('cache-control'), 'private, no-store');
    if (status === 401) assert.equal(failed.headers.get('www-authenticate'), 'Bearer');
    if (status === 429) assert.equal(failed.headers.get('retry-after'), '12');
  }
  const count = calls.length;
  assert.equal((await fetch(base + '/api/v1/recommendations/internal', { headers })).status, 404);
  assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 404);
  assert.equal(calls.length, count, 'solo publica el GET acordado');
  hang = true;
  assert.equal((await fetch(base + path, { headers })).status, 504);
});
