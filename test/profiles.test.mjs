import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { library } from '../dist/library-service/src/server.js';
import { profilesStore } from '../dist/library-service/src/profiles.js';
import { listen } from './helpers.mjs';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';

test('Perfiles Prisma: creación idempotente y memoria limitada', async () => {
  const calls = [];
  const store = profilesStore({ profile: { async createMany(args) { calls.push(args); return { count: 1 }; } } }, 2);
  await store.ensure(alice);
  await store.ensure(alice);
  assert.equal(calls.length, 1, 'un perfil ya asegurado no se vuelve a consultar');
  assert.deepEqual(calls[0], { data: { id: alice }, skipDuplicates: true });
  await store.ensure(bob);
  await store.ensure('33333333-3333-4333-8333-333333333333');
  await store.ensure(alice);
  assert.equal(calls.length, 4, 'al superar el límite se olvida el más antiguo');
});

test('Library crea el perfil en la primera escritura en lugar de responder 409', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'profiles', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const sign = sub => new SignJWT({ sub }).setProtectedHeader({ alg: 'ES256', kid: 'profiles' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);

  // Simula la llave foránea: escribir sin perfil falla como PostgreSQL (P2003).
  const profiles = new Set();
  let ensured = 0;
  let failing = false;
  const profileStore = { async ensure(id) { ensured++; if (failing) throw new Error('db caída'); profiles.add(id); } };
  const fkCheck = user => { if (!profiles.has(user)) throw Object.assign(new Error('fk'), { code: 'P2003' }); };
  const watchlist = {
    async list() { return []; },
    async add(user, ref) { fkCheck(user); return { ...ref, status: 'pending', created_at: '2026-11-10T00:00:00.000Z' }; },
    async remove() {}
  };
  const auth = { supabaseUrl: issuer };
  const path = '/api/v1/library/watchlist';
  const headers = { Authorization: 'Bearer ' + await sign(alice) };

  // Sin el almacén de perfiles se reproduce el problema original.
  const before = await listen(t, library(watchlist, auth));
  assert.equal((await fetch(before + path + '/movie/1', { method: 'PUT', headers })).status, 409);

  const base = await listen(t, library(watchlist, auth, undefined, undefined, { profiles: profileStore }));
  assert.equal((await fetch(base + path, { headers })).status, 200);
  assert.equal(ensured, 0, 'las lecturas no crean perfiles');
  assert.equal((await fetch(base + path + '/movie/1', { method: 'PUT', headers })).status, 200);
  assert.deepEqual([...profiles], [alice], 'el perfil usa el sub verificado del JWT');
  assert.equal((await fetch(base + path + '/movie/1', { method: 'DELETE', headers })).status, 204);
  assert.equal(ensured, 1, 'borrar no crea perfiles');

  // Si no se puede asegurar el perfil, Library responde indisponible sin detalles internos.
  failing = true;
  const bobHeaders = { Authorization: 'Bearer ' + await sign(bob) };
  const unavailable = await fetch(base + path + '/movie/1', { method: 'PUT', headers: bobHeaders });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'Library no disponible' });
});
