import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gateway } from '../dist/api-gateway/src/server.js';
import { library } from '../dist/library-service/src/server.js';
import { toScores } from '../dist/library-service/src/detector.js';
import { emotionStore } from '../dist/library-service/src/emotions.js';
import { HttpFailure } from '../dist/shared/http.js';
import { listen } from './helpers.mjs';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]).toString('base64');
const NAMES = { HAPPY: 'Felicidad', SAD: 'Tristeza', ANGRY: 'Enojo', FEAR: 'Miedo', DISGUSTED: 'Desagrado', SURPRISED: 'Sorpresa', CALM: 'Neutralidad / calma' };

// Almacén en memoria con el mismo contrato que el de Prisma: un registro por usuario y día.
function memoryStore() {
  const consents = new Map(), zones = new Map(), days = new Map(), saved = new Map();
  let next = 0;
  const entry = row => ({ ...row, recommendations: [...(saved.get(row.id)?.values() ?? [])] });
  return {
    days,
    async consent(user) { const c = consents.get(user); return c ?? { granted: false, policy_version: null, granted_at: null }; },
    async grant(user, version) { const c = { granted: true, policy_version: version, granted_at: '2026-11-10T00:00:00.000Z' }; consents.set(user, c); return c; },
    async revoke(user) { consents.delete(user); },
    async timeZone(user) { return zones.get(user) ?? 'UTC'; },
    async setTimeZone(user, zone) { zones.set(user, zone); },
    async record(user, { date, detectedAt, scores }) {
      const key = user + ':' + date.toISOString().slice(0, 10);
      const replaced = days.has(key);
      const id = replaced ? days.get(key).id : `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
      const row = { id, user, date: date.toISOString().slice(0, 10), mood: scores[0].mood, name: NAMES[scores[0].mood],
        confidence: scores[0].confidence, scores, detected_at: detectedAt.toISOString() };
      days.set(key, row);
      return { entry: entry(row), replaced };
    },
    async history(user, from, to) {
      return [...days.values()].filter(row => row.user === user && row.date >= from.toISOString().slice(0, 10) && row.date <= to.toISOString().slice(0, 10))
        .map(({ user: _u, ...row }) => entry(row));
    },
    async saveRecommendation(user, id, ref, input) {
      const row = [...days.values()].find(item => item.id === id && item.user === user);
      if (!row) throw new HttpFailure(404, 'Registro de emoción no encontrado');
      const item = { ...ref, ...input, saved_at: '2026-11-10T00:00:00.000Z' };
      if (!saved.has(id)) saved.set(id, new Map());
      saved.get(id).set(ref.media_type + ':' + ref.tmdb_id, item);
      return item;
    }
  };
}

test('Emociones: consentimiento, detección, historial y recomendaciones guardadas', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'emotions', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const sign = sub => new SignJWT({ sub }).setProtectedHeader({ alg: 'ES256', kid: 'emotions' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const auth = { supabaseUrl: issuer };

  const store = memoryStore();
  let detection = { faces: 1, scores: [{ mood: 'SAD', confidence: 91.2 }, { mood: 'CALM', confidence: 6.1 }] };
  const images = [];
  const detector = { async detect(image) { images.push(image); return detection; } };
  const profiles = { ensured: [], async ensure(id) { this.ensured.push(id); } };
  const watchlist = { async list() { return []; }, async add() { return {}; }, async remove() {} };
  const internal = await listen(t, library(watchlist, auth, undefined, undefined, { profiles, emotions: { store, detector } }));
  const frontend = 'http://localhost:5173';
  const base = await listen(t, gateway('http://127.0.0.1:9', frontend, auth, undefined, 7000, internal));
  const headers = { Authorization: 'Bearer ' + await sign(alice), 'Content-Type': 'application/json' };
  const bobHeaders = { Authorization: 'Bearer ' + await sign(bob), 'Content-Type': 'application/json' };
  const api = base + '/api/v1/emotions';
  const detect = (body, h = headers) => fetch(api + '/detections', { method: 'POST', headers: h, body: JSON.stringify(body) });

  // Autenticación y CORS para POST.
  assert.equal((await fetch(api + '/history')).status, 401);
  const preflight = await fetch(api + '/detections', { method: 'OPTIONS', headers: {
    Origin: frontend, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);

  // Sin consentimiento no se analiza ninguna imagen.
  assert.deepEqual(await (await fetch(api + '/consent', { headers })).json(), { granted: false, policy_version: null, granted_at: null });
  const denied = await detect({ image: JPEG });
  assert.equal(denied.status, 403);
  assert.equal(images.length, 0);
  assert.equal((await fetch(api + '/consent', { method: 'PUT', headers, body: '{}' })).status, 400);
  const granted = await fetch(api + '/consent', { method: 'PUT', headers, body: JSON.stringify({ policy_version: '2026-11' }) });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).granted, true);

  // Validación de la imagen y del cuerpo, antes de llamar al proveedor.
  const cases = [
    [{}, 400], [{ image: 'no es base64!' }, 415], [{ image: Buffer.from('texto plano').toString('base64') }, 415],
    [{ image: JPEG, user_id: bob }, 400], [{ image: JPEG, time_zone: 'Marte/Base' }, 400],
    [{ image: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2.1 * 1024 * 1024)]).toString('base64') }, 413]
  ];
  for (const [body, status] of cases) assert.equal((await detect(body)).status, status, JSON.stringify(body).slice(0, 60));
  assert.equal(images.length, 0);

  // Sin rostro o con poca confianza no se registra nada.
  detection = { faces: 0, scores: [] };
  assert.equal((await detect({ image: JPEG })).status, 422);
  detection = { faces: 1, scores: [{ mood: 'HAPPY', confidence: 21 }] };
  assert.equal((await detect({ image: PNG })).status, 422);
  assert.equal(store.days.size, 0);

  // Detección válida: 201, código del catálogo, día local según la zona enviada.
  detection = { faces: 2, scores: [{ mood: 'SAD', confidence: 91.2 }, { mood: 'CALM', confidence: 6.1 }] };
  const created = await detect({ image: 'data:image/jpeg;base64,' + JPEG, time_zone: 'America/Guatemala' });
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(first.mood, 'SAD');
  assert.equal(first.name, 'Tristeza');
  assert.equal(first.confidence, 91.2);
  assert.equal(first.faces, 2);
  assert.equal(first.replaced, false);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
  assert.equal(first.date, today);
  assert.deepEqual(profiles.ensured.at(-1), alice, 'POST asegura el perfil');

  // Una segunda detección el mismo día reemplaza la anterior (un registro por usuario y día).
  detection = { faces: 1, scores: [{ mood: 'HAPPY', confidence: 88 }] };
  const second = await detect({ image: JPEG });
  assert.equal(second.status, 200);
  const replaced = await second.json();
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.mood, 'HAPPY');

  // Recomendación guardada para ese registro; aparece en el historial.
  const recPath = `${api}/history/${first.id}/recommendations/movie/354912`;
  const rec = { title: 'Coco', poster_path: '/coco.jpg', release_date: '2017-10-27', vote_average: 8.2, genre_ids: [16, 10751] };
  const savedRec = await fetch(recPath, { method: 'PUT', headers, body: JSON.stringify(rec) });
  assert.equal(savedRec.status, 200);
  assert.equal((await savedRec.json()).title, 'Coco');
  for (const body of [{}, { title: 'x', extra: 1 }, { title: 'x', vote_average: 11 }, { title: 'x', release_date: '2017' }]) {
    assert.equal((await fetch(recPath, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
  }
  assert.equal((await fetch(recPath, { method: 'PUT', headers: bobHeaders, body: JSON.stringify(rec) })).status, 404, 'no se puede usar el registro de otro usuario');
  assert.equal((await fetch(`${api}/history/no-es-uuid/recommendations/movie/1`, { method: 'PUT', headers, body: '{}' })).status, 400);

  const history = await (await fetch(api + '/history?period=7d', { headers })).json();
  assert.equal(history.results.length, 1);
  assert.equal(history.results[0].mood, 'HAPPY');
  assert.equal(history.results[0].recommendations[0].tmdb_id, 354912);
  assert.equal((await (await fetch(api + '/history?year=' + today.slice(0, 4), { headers })).json()).results.length, 1);
  assert.deepEqual(await (await fetch(api + '/history', { headers: bobHeaders })).json(), { results: [] });
  for (const query of ['?period=1y', '?year=99', '?period=7d&year=2026', '?user_id=x']) {
    assert.equal((await fetch(api + '/history' + query, { headers })).status, 400, query);
  }

  // Revocar el consentimiento bloquea nuevas detecciones.
  assert.equal((await fetch(api + '/consent', { method: 'DELETE', headers })).status, 204);
  assert.equal((await detect({ image: JPEG })).status, 403);

  // Sin detector configurado (sin AWS_REGION) la detección responde 503.
  const unconfigured = await listen(t, library(watchlist, auth, undefined, undefined, { emotions: { store } }));
  const direct = await fetch(unconfigured + '/api/v1/emotions/detections', { method: 'POST', headers, body: JSON.stringify({ image: JPEG }) });
  assert.equal(direct.status, 503);
});

test('Rekognition: conversión de emociones al catálogo', () => {
  assert.deepEqual(toScores([
    { Type: 'CALM', Confidence: 10 }, { Type: 'HAPPY', Confidence: 70.456 }, { Type: 'CONFUSED', Confidence: 5 },
    { Type: 'SURPRISED', Confidence: 4 }, { Type: 'UNKNOWN', Confidence: 50 }, { Type: 'FEAR' }
  ]), [
    { mood: 'HAPPY', confidence: 70.46 }, { mood: 'CALM', confidence: 10 }, { mood: 'SURPRISED', confidence: 9 }
  ]);
});

test('Emociones Prisma: reemplazo diario y consultas por usuario', async () => {
  const calls = [];
  const row = { id: 'h1', detectionDate: new Date('2026-11-10T00:00:00Z'), detectedAt: new Date('2026-11-10T15:00:00Z'), primaryMoodCode: 'SAD',
    scores: [{ moodCode: 'CALM', confidence: '6.1' }, { moodCode: 'SAD', confidence: '91.2' }], savedRecommendations: [] };
  let existing = { id: 'h1' };
  const tx = {
    moodHistory: {
      async findUnique(args) { calls.push(['find', args]); return existing; },
      async update(args) { calls.push(['update', args]); return { id: 'h1' }; },
      async create(args) { calls.push(['create', args]); return { id: 'h1' }; },
      async findFirstOrThrow(args) { calls.push(['reload', args]); return row; },
      async findMany(args) { calls.push(['history', args]); return [row]; },
      async findFirst(args) { calls.push(['owner', args]); return null; }
    },
    moodHistoryScore: {
      async deleteMany(args) { calls.push(['deleteScores', args]); },
      async createMany(args) { calls.push(['scores', args]); }
    }
  };
  const store = emotionStore({ ...tx, $transaction: fn => fn(tx) });
  const scores = [{ mood: 'SAD', confidence: 91.2 }, { mood: 'CALM', confidence: 6.1 }];
  const date = new Date('2026-11-10T00:00:00Z');
  const result = await store.record(alice, { date, detectedAt: row.detectedAt, scores });
  assert.equal(result.replaced, true);
  assert.deepEqual(result.entry.scores, scores, 'puntajes ordenados de mayor a menor');
  assert.equal(result.entry.confidence, 91.2);
  assert.deepEqual(calls.map(([op]) => op), ['find', 'update', 'deleteScores', 'scores', 'reload']);
  assert.deepEqual(calls[0][1].where, { profileId_detectionDate: { profileId: alice, detectionDate: date } });
  assert.equal(calls[4][1].where.profileId, alice);

  calls.length = 0;
  existing = null;
  assert.equal((await store.record(alice, { date, detectedAt: row.detectedAt, scores })).replaced, false);
  assert.deepEqual(calls.map(([op]) => op), ['find', 'create', 'scores', 'reload']);
  assert.equal(calls[1][1].data.profileId, alice);

  const history = await store.history(alice, date, date);
  assert.equal(history[0].date, '2026-11-10');
  assert.equal(calls.at(-1)[1].where.profileId, alice);
  await assert.rejects(store.saveRecommendation(bob, 'h1', { tmdb_id: 1, media_type: 'movie' }, { title: 'x', poster_path: null,
    overview: null, release_date: null, vote_average: null, genre_ids: [] }), { status: 404 });
  assert.deepEqual(calls.at(-1)[1].where, { id: 'h1', profileId: bob });
});
