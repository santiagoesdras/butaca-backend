import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gateway } from '../dist/api-gateway/src/server.js';
import { listen } from './helpers.mjs';

test('Gateway valida JWT y protege ambos dominios privados', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'ES256', use: 'sig' };
  let keyRequests = 0;
  const issuerOrigin = await listen(t, (req, res) => {
    assert.equal(req.url, '/auth/v1/.well-known/jwks.json');
    keyRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  const origin = 'http://localhost:5173';
  const media = await listen(t, (_req, res) => res.end(JSON.stringify({ page: 1, results: [] })));
  const base = await listen(t, gateway(media, origin, { supabaseUrl: issuerOrigin }));
  const sign = (claims = {}, key = privateKey) => new SignJWT({
    sub: 'user-test', iss: issuerOrigin + '/auth/v1', aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 300, ...claims
  }).setProtectedHeader({ alg: 'ES256', kid: 'test' }).sign(key);
  const valid = await sign();
  const invalid = [
    'abc', await sign({}, other.privateKey), await sign({ exp: 1 }),
    await sign({ iss: 'https://another-project/auth/v1' }),
    await sign({ aud: 'anon' }), await sign({ sub: '' }),
    await sign({ exp: undefined }), await sign({ sub: undefined }),
    await sign({ nbf: Math.floor(Date.now() / 1000) + 600 })
  ];
  const hs256 = await new SignJWT({ sub: 'user-test', iss: issuerOrigin + '/auth/v1', aud: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new Uint8Array(32));
  invalid.push(hs256);

  for (const path of ['/api/v1/library', '/api/v1/library/favorites', '/api/v1/recommendations']) {
    const missing = await fetch(base + path, { headers: { 'X-User-Id': 'fake-user' } });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
    for (const token of invalid) {
      const response = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const body = await response.json();
      assert.equal(typeof body.error, 'string');
      assert.ok(!body.error.includes(token));
    }
    // El token válido supera la autenticación; Library no tiene ruta y Recommendation no tiene origen aquí.
    const accepted = await fetch(base + path, { headers: { Authorization: 'Bearer ' + valid } });
    assert.equal(accepted.status, path === '/api/v1/recommendations' ? 503 : 404);
    assert.deepEqual(await accepted.json(), { error: path === '/api/v1/recommendations'
      ? 'Recommendation Service no configurado' : 'Ruta desconocida' });
  }
  assert.equal(keyRequests, 1, 'reutiliza las claves públicas');
  assert.equal((await fetch(base + '/health/live')).status, 200);
  assert.equal((await fetch(base + '/api/v1/media/trending')).status, 200);
  assert.equal((await fetch(base + '/api/v1/library/favorites', { method: 'POST' })).status, 401);

  const preflight = await fetch(base + '/api/v1/library/favorites', {
    method: 'OPTIONS',
    headers: {
      Origin: origin, 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);

  const unconfigured = await listen(t, gateway(media, origin));
  assert.equal((await fetch(unconfigured + '/api/v1/library')).status, 503);
  assert.equal((await fetch(unconfigured + '/api/v1/media/trending')).status, 200);
  const failingKeys = await listen(t, (_req, res) => res.writeHead(503).end());
  const unavailable = await listen(t, gateway(media, origin, { supabaseUrl: failingKeys }));
  assert.equal((await fetch(unavailable + '/api/v1/library', {
    headers: { Authorization: 'Bearer ' + valid }
  })).status, 503);
});
