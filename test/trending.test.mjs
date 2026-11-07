import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gateway } from '../dist/api-gateway/src/server.js';
import { media } from '../dist/media-service/src/server.js';

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('Gateway → Media → proveedor HTTP', async t => {
  let calls = 0;
  let mode = 'ok';
  const provider = await listen(t, (req, res) => {
    calls++;
    if (req.headers.authorization !== 'Bearer prueba') return res.writeHead(401).end();
    if (!req.url.startsWith('/3/trending/all/day?language=')) return res.writeHead(404).end();
    if (mode === 'slow') return;
    if (mode === 'limited') return res.writeHead(429, { 'Retry-After': '12' }).end();
    setTimeout(() => res.end(JSON.stringify({ page: 1, results: [
      { media_type: 'tv', id: 2, name: 'Serie' }, { media_type: 'person' },
      { media_type: 'movie', id: 3, title: 'Película' }
    ] })), 10);
  });
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
      { media_type: 'tv', id: 2, title: 'Serie', poster_path: null },
      { media_type: 'movie', id: 3, title: 'Película', poster_path: null }
    ] });
  }
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + '?language=bad')).status, 400);
  assert.equal(calls, 1);
  mode = 'limited';
  const limited = await fetch(url + '?language=en-US');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '12');
  mode = 'slow';
  assert.equal((await fetch(url + '?language=en-US')).status, 504);
  mode = 'ok';
  assert.equal((await fetch(url + '?language=en-US')).status, 200);
});
