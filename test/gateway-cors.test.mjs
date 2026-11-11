import test from 'node:test';
import assert from 'node:assert/strict';
import { gateway } from '../dist/api-gateway/src/server.js';
import { listen } from './helpers.mjs';

test('Gateway expone Retry-After y los encabezados de límite al frontend', async t => {
  // Media simulado que responde 429 con plazo de espera.
  const mediaOrigin = await listen(t, (_req, res) =>
    res.writeHead(429, { 'Retry-After': '30', 'Content-Type': 'application/json' }).end('{"error":"Límite"}'));
  const origin = 'http://localhost:5173';
  const base = await listen(t, gateway(mediaOrigin, origin));

  const limited = await fetch(base + '/api/v1/media/trending', { headers: { Origin: origin } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.equal(limited.headers.get('access-control-allow-origin'), origin);
  const exposed = (limited.headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/\s*,\s*/);
  for (const header of ['retry-after', 'ratelimit', 'ratelimit-policy']) assert.ok(exposed.includes(header), header);
  assert.ok(limited.headers.get('ratelimit'), 'el limitador del Gateway publica RateLimit');

});
