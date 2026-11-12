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
    async record(user, { date, detectedAt, mood, scores, source }) {
      const key = user + ':' + date.toISOString().slice(0, 10);
      const replaced = days.has(key);
      const id = replaced ? days.get(key).id : `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
      const row = { id, user, date: date.toISOString().slice(0, 10), mood, name: NAMES[mood],
        confidence: scores.find(score => score.mood === mood)?.confidence ?? null, source, scores, detected_at: detectedAt.toISOString() };
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
      const item = { ...ref, ...input, saved_at: new Date().toISOString(), mood: row.mood, mood_name: row.name, mood_detected_at: row.detected_at };
      if (!saved.has(id)) saved.set(id, new Map());
      saved.get(id).set(ref.media_type + ':' + ref.tmdb_id, item);
      return item;
    }
  };
}

test('Emociones: consentimiento, emoción confirmada, historial, resumen y recomendaciones guardadas', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'emotions', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const sign = sub => new SignJWT({ sub }).setProtectedHeader({ alg: 'ES256', kid: 'emotions' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const auth = { supabaseUrl: issuer };

  const store = memoryStore();
  const profiles = { ensured: [], async ensure(id) { this.ensured.push(id); } };
  const watchlist = { async list() { return []; }, async add() { return {}; }, async remove() {} };
  const internal = await listen(t, library(watchlist, auth, undefined, undefined, { profiles, emotions: { store } }));
  const frontend = 'http://localhost:5173';
  const base = await listen(t, gateway('http://127.0.0.1:9', frontend, auth, undefined, 7000, internal));
  const headers = { Authorization: 'Bearer ' + await sign(alice), 'Content-Type': 'application/json' };
  const bobHeaders = { Authorization: 'Bearer ' + await sign(bob), 'Content-Type': 'application/json' };
  const api = base + '/api/v1/emotions';
  const confirm = (body, h = headers) => fetch(api + '/history', { method: 'POST', headers: h, body: JSON.stringify(body) });

  // Autenticación y CORS para POST.
  assert.equal((await fetch(api + '/history')).status, 401);
  assert.equal((await fetch(api + '/summary')).status, 401);
  const preflight = await fetch(api + '/history', { method: 'OPTIONS', headers: {
    Origin: frontend, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);

  // La ruta que recibía la foto por segunda vez ya no existe: la imagen solo pasa por /analyze.
  assert.equal((await fetch(api + '/detections', { method: 'POST', headers, body: '{}' })).status, 404);

  // Sin consentimiento no se registra ninguna emoción.
  assert.deepEqual(await (await fetch(api + '/consent', { headers })).json(), { granted: false, policy_version: null, granted_at: null });
  assert.equal((await confirm({ mood: 'SAD', confidence: 91.2 })).status, 403);
  assert.equal((await fetch(api + '/consent', { method: 'PUT', headers, body: '{}' })).status, 400);
  const granted = await fetch(api + '/consent', { method: 'PUT', headers, body: JSON.stringify({ policy_version: '2026-11' }) });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).granted, true);

  // Validación con Zod: emoción del catálogo, confianza 0-100, zona IANA y sin campos extra (ni imagen).
  const cases = [
    [{}, /mood/], [{ mood: 'fearful' }, /mood/], [{ mood: 'FEAR', confidence: 101 }, /confidence/],
    [{ mood: 'FEAR', time_zone: 'Marte/Base' }, /time_zone/], [{ mood: 'FEAR', user_id: bob }, /Campos no admitidos: user_id/],
    [{ mood: 'FEAR', image: 'abc' }, /Campos no admitidos: image/]
  ];
  for (const [body, message] of cases) {
    const response = await confirm(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, message);
  }
  assert.equal((await fetch(api + '/history', { method: 'POST', headers, body: JSON.stringify({ mood: 'SAD', note: 'x'.repeat(1100) }) })).status, 413);
  assert.equal(store.days.size, 0);

  // Emoción sugerida por /analyze y confirmada: 201, conserva la confianza y el día local del usuario.
  const created = await confirm({ mood: 'SAD', confidence: 91.2, time_zone: 'America/Guatemala' });
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(first.mood, 'SAD');
  assert.equal(first.name, 'Tristeza');
  assert.equal(first.confidence, 91.2);
  assert.equal(first.source, 'AWS_REKOGNITION');
  assert.equal(first.replaced, false);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
  assert.equal(first.date, today);
  assert.deepEqual(profiles.ensured.at(-1), alice, 'POST asegura el perfil');

  // Recomendación guardada mientras la emoción del día era Tristeza.
  const sadRec = await fetch(`${api}/history/${first.id}/recommendations/movie/438631`, { method: 'PUT', headers,
    body: JSON.stringify({ title: 'Duna', genre_ids: [878] }) });
  assert.equal(sadRec.status, 200);
  assert.equal((await sadRec.json()).mood, 'SAD');

  // Confirmar otra emoción el mismo día reemplaza el registro (uno por usuario y día). Sin confianza = elegida.
  const second = await confirm({ mood: 'CALM' });
  assert.equal(second.status, 200);
  const replaced = await second.json();
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.mood, 'CALM');
  assert.equal(replaced.confidence, null);
  assert.equal(replaced.source, 'USER_SELECTED');

  // Recomendación guardada para ese registro; aparece en el historial.
  const recPath = `${api}/history/${first.id}/recommendations/movie/354912`;
  const rec = { title: 'Coco', poster_path: '/coco.jpg', release_date: '2017-10-27', vote_average: 8.2, genre_ids: [16, 10751] };
  const savedRec = await fetch(recPath, { method: 'PUT', headers, body: JSON.stringify(rec) });
  assert.equal(savedRec.status, 200);
  assert.equal((await savedRec.json()).title, 'Coco');
  for (const [body, message] of [[{}, /title/], [{ title: 'x', extra: 1 }, /extra/], [{ title: 'x', vote_average: 11 }, /vote_average/],
    [{ title: 'x', release_date: '2017' }, /release_date/], [{ title: 'x', genre_ids: [0] }, /genre_ids/]]) {
    const response = await fetch(recPath, { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, message);
  }
  assert.equal((await fetch(recPath, { method: 'PUT', headers: bobHeaders, body: JSON.stringify(rec) })).status, 404, 'no se puede usar el registro de otro usuario');
  assert.equal((await fetch(`${api}/history/no-es-uuid/recommendations/movie/1`, { method: 'PUT', headers, body: '{}' })).status, 400);

  const history = await (await fetch(api + '/history?period=7d', { headers })).json();
  assert.equal(history.results.length, 1);
  assert.equal(history.results[0].mood, 'CALM', 'el día queda con la última emoción confirmada');
  // Pero cada recomendación conserva la emoción con la que se hizo.
  assert.deepEqual(history.results[0].recommendations.map(rec => [rec.title, rec.mood, rec.mood_name]),
    [['Duna', 'SAD', 'Tristeza'], ['Coco', 'CALM', 'Neutralidad / calma']]);
  assert.equal((await (await fetch(api + '/history?year=' + today.slice(0, 4), { headers })).json()).results.length, 1);
  assert.deepEqual(await (await fetch(api + '/history', { headers: bobHeaders })).json(), { results: [] });
  for (const query of ['?period=1y', '?year=99', '?period=7d&year=2026', '?user_id=x']) {
    assert.equal((await fetch(api + '/history' + query, { headers })).status, 400, query);
  }

  // Resumen del tablero agregado en el backend.
  const summary = await (await fetch(api + '/summary?period=7d', { headers })).json();
  assert.equal(summary.period, '7d');
  assert.equal(summary.total_records, 1);
  assert.deepEqual(summary.predominant, { mood: 'CALM', name: 'Neutralidad / calma', count: 1 });
  assert.equal(summary.distribution.length, 7, 'incluye las 7 emociones, también las que no aparecen');
  assert.equal(summary.timeline.length, 7);
  assert.equal(summary.timeline.find(point => point.bucket === today).counts.CALM, 1);
  assert.equal(summary.recommendations.total, 2);
  assert.deepEqual(summary.recommendations.by_media_type, { movie: 2, tv: 0 });
  assert.deepEqual(summary.recommendations.by_genre, [{ genre_id: 16, count: 1 }, { genre_id: 878, count: 1 }, { genre_id: 10751, count: 1 }]);
  // Por emoción se cuenta la de cada recomendación, no la final del día.
  const byMood = Object.fromEntries(summary.recommendations.by_mood.map(item => [item.mood, item.count]));
  assert.equal(byMood.SAD, 1);
  assert.equal(byMood.CALM, 1);
  assert.deepEqual(summary.recommendations.recent.map(rec => rec.mood).sort(), ['CALM', 'SAD']);
  const yearly = await (await fetch(api + '/summary?period=year', { headers })).json();
  assert.equal(yearly.timeline.length, 12);
  assert.equal(yearly.timeline.find(point => point.bucket === today.slice(0, 7)).counts.CALM, 1);
  const empty = await (await fetch(api + '/summary', { headers: bobHeaders })).json();
  assert.equal(empty.period, '30d');
  assert.equal(empty.predominant, null);
  assert.equal(empty.recommendations.total, 0);
  for (const query of ['?period=1y', '?year=2026']) assert.equal((await fetch(api + '/summary' + query, { headers })).status, 400, query);

  // Revocar el consentimiento bloquea nuevos registros.
  assert.equal((await fetch(api + '/consent', { method: 'DELETE', headers })).status, 204);
  assert.equal((await confirm({ mood: 'HAPPY' })).status, 403);
});

test('Rekognition: conversión de emociones al catálogo', () => {
  assert.deepEqual(toScores([
    { Type: 'CALM', Confidence: 10 }, { Type: 'HAPPY', Confidence: 70.456 }, { Type: 'CONFUSED', Confidence: 5 },
    { Type: 'SURPRISED', Confidence: 4 }, { Type: 'UNKNOWN', Confidence: 50 }, { Type: 'FEAR' }
  ]), [
    { mood: 'HAPPY', confidence: 70.46 }, { mood: 'CALM', confidence: 10 }, { mood: 'SURPRISED', confidence: 4 }
  ]);
});

test('Emociones Prisma: reemplazo diario y consultas por usuario', async () => {
  const calls = [];
  const row = { id: 'h1', detectionDate: new Date('2026-11-10T00:00:00Z'), detectedAt: new Date('2026-11-10T15:00:00Z'), primaryMoodCode: 'SAD', source: 'AWS_REKOGNITION',
    scores: [{ moodCode: 'CALM', confidence: '6.1' }, { moodCode: 'SAD', confidence: '91.2' }],
    savedRecommendations: [{ tmdbId: 7, mediaType: 'MOVIE', title: 'X', posterPath: null, overview: null, releaseDate: null, voteAverage: null,
      genreIds: [], savedAt: new Date('2026-11-10T15:05:00Z'), moodCodeAtSave: 'FEAR', moodDetectedAt: new Date('2026-11-10T14:00:00Z') }] };
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
  const result = await store.record(alice, { date, detectedAt: row.detectedAt, mood: 'SAD', scores, source: 'AWS_REKOGNITION' });
  assert.equal(result.replaced, true);
  assert.deepEqual(result.entry.scores, scores, 'puntajes ordenados de mayor a menor');
  assert.equal(result.entry.confidence, 91.2);
  assert.deepEqual(calls.map(([op]) => op), ['find', 'update', 'deleteScores', 'scores', 'reload']);
  assert.deepEqual(calls[0][1].where, { profileId_detectionDate: { profileId: alice, detectionDate: date } });
  assert.equal(calls[4][1].where.profileId, alice);

  calls.length = 0;
  existing = null;
  assert.equal((await store.record(alice, { date, detectedAt: row.detectedAt, mood: 'SAD', scores, source: 'AWS_REKOGNITION' })).replaced, false);
  assert.deepEqual(calls.map(([op]) => op), ['find', 'create', 'scores', 'reload']);
  assert.equal(calls[1][1].data.profileId, alice);

  const history = await store.history(alice, date, date);
  assert.equal(history[0].date, '2026-11-10');
  assert.equal(history[0].recommendations[0].mood, 'FEAR', 'la recomendación conserva su emoción aunque el día sea SAD');
  assert.equal(history[0].recommendations[0].mood_name, 'Miedo');
  assert.equal(calls.at(-1)[1].where.profileId, alice);
  await assert.rejects(store.saveRecommendation(bob, 'h1', { tmdb_id: 1, media_type: 'movie' }, { title: 'x', poster_path: null,
    overview: null, release_date: null, vote_average: null, genre_ids: [] }), { status: 404 });
  assert.deepEqual(calls.at(-1)[1].where, { id: 'h1', profileId: bob });
});
