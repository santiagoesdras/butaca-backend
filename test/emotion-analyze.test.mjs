import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gateway } from '../dist/api-gateway/src/server.js';
import { library } from '../dist/library-service/src/server.js';
import { rekognitionDetector } from '../dist/library-service/src/detector.js';
import { HttpFailure } from '../dist/shared/http.js';
import { listen } from './helpers.mjs';

const user = '11111111-1111-4111-8111-111111111111';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(20, 2)
]);

function form({ image = JPEG, type = 'image/jpeg', consent = 'true', omitImage = false, omitConsent = false, extra, second } = {}) {
  const body = new FormData();
  if (!omitConsent) body.append('consent', consent);
  if (!omitImage) body.append('image', new Blob([image], { type }), type === 'image/png' ? 'face.png' : 'face.jpg');
  if (extra) body.append(extra[0], extra[1]);
  if (second) body.append('image', new Blob([second], { type }), 'second.jpg');
  return body;
}

function unusedStore() {
  return {
    async consent() { return { granted: false, policy_version: null, granted_at: null }; },
    async grant() { throw new Error('not used'); }, async revoke() {}, async timeZone() { return 'UTC'; },
    async setTimeZone() {}, async record() { throw new Error('analyze must not persist'); },
    async history() { return []; }, async saveRecommendation() { throw new Error('not used'); }
  };
}

test('Análisis multipart: autenticación, validación, normalización y errores', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'analyze', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const token = await new SignJWT({ sub: user }).setProtectedHeader({ alg: 'ES256', kid: 'analyze' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const auth = { supabaseUrl: issuer };
  let result = { faces: 1, scores: [{ mood: 'HAPPY', confidence: 92.34 }] };
  let failure;
  let calls = 0;
  const detector = { async detect(image) {
    calls++;
    assert.ok(image instanceof Uint8Array);
    if (failure) throw failure;
    return result;
  } };
  const profiles = { calls: 0, async ensure() { this.calls++; } };
  const watchlist = { async list() { return []; }, async add() { return {}; }, async remove() {} };
  const internal = await listen(t, library(watchlist, auth, undefined, undefined, {
    profiles, emotions: { store: unusedStore(), detector, analyze: { minConfidence: 30, limit: 100, windowMs: 60000 } }
  }));
  const frontend = 'http://localhost:5173';
  const base = await listen(t, gateway('http://127.0.0.1:9', frontend, auth, undefined, 7000, internal));
  const url = base + '/api/v1/emotions/analyze';
  const send = (body = form(), authorization = token) => fetch(url, {
    method: 'POST', headers: authorization ? { Authorization: 'Bearer ' + authorization } : {}, body
  });

  assert.equal((await send(form(), '')).status, 401);
  assert.equal((await send(form(), 'not-a-jwt')).status, 401);
  assert.equal(calls, 0, 'el JWT se valida antes de procesar la imagen');

  assert.equal((await send(form({ omitConsent: true }))).status, 400);
  assert.equal((await send(form({ consent: 'false' }))).status, 400);
  assert.equal((await send(form({ omitImage: true }))).status, 400);
  assert.equal((await send(form({ extra: ['user_id', user] }))).status, 400);
  assert.equal((await send(form({ second: JPEG }))).status, 400);
  assert.equal((await send(form({ image: Buffer.from('not an image'), type: 'image/jpeg' }))).status, 415);
  assert.equal((await send(form({ image: PNG, type: 'image/jpeg' }))).status, 415);
  assert.equal((await send(form({ image: Buffer.alloc(2 * 1024 * 1024 + 1), type: 'image/jpeg' }))).status, 413);
  assert.equal(calls, 0, 'las entradas inválidas no llegan al detector');

  const ok = await send();
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    suggestedExpression: 'HAPPY', confidence: 92.34, confirmationRequired: true, faces: 1, reason: null
  });
  assert.equal(profiles.calls, 0, 'el análisis efímero no crea ni modifica perfiles');

  result = { faces: 0, scores: [] };
  assert.equal((await send()).status, 422);
  result = { faces: 2, scores: [{ mood: 'HAPPY', confidence: 90 }] };
  assert.equal((await send()).status, 422);

  result = { faces: 1, scores: [{ mood: 'HAPPY', confidence: 15 }] };
  const weak = await send(form({ image: PNG, type: 'image/png' }));
  assert.equal(weak.status, 200);
  assert.deepEqual(await weak.json(), {
    suggestedExpression: null, confidence: null, confirmationRequired: true, faces: 1, reason: 'insufficient_confidence'
  });

  result = { faces: 1, scores: [{ mood: 'HAPPY', confidence: 10 }], unsupportedTop: 'CONFUSED' };
  const unknown = await send();
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), {
    suggestedExpression: null, confidence: null, confirmationRequired: true, faces: 1, reason: 'unsupported_expression'
  });

  failure = new HttpFailure(502, 'El servicio de análisis de emociones no está disponible');
  assert.equal((await send()).status, 502);
  failure = new HttpFailure(504, 'El análisis de emociones tardó demasiado');
  assert.equal((await send()).status, 504);
});

test('Análisis aplica el límite por usuario', async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'rate', alg: 'ES256' };
  const issuer = await listen(t, (_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  const token = await new SignJWT({ sub: user }).setProtectedHeader({ alg: 'ES256', kid: 'rate' })
    .setIssuer(issuer + '/auth/v1').setAudience('authenticated').setExpirationTime('1h').sign(privateKey);
  const auth = { supabaseUrl: issuer };
  const watchlist = { async list() { return []; }, async add() { return {}; }, async remove() {} };
  const internal = await listen(t, library(watchlist, auth, undefined, undefined, {
    emotions: { store: unusedStore(), detector: { async detect() { return { faces: 1, scores: [{ mood: 'CALM', confidence: 90 }] }; } },
      analyze: { limit: 1, windowMs: 60000 } }
  }));
  const base = await listen(t, gateway('http://127.0.0.1:9', 'http://localhost:5173', auth, undefined, 7000, internal));
  const send = () => fetch(base + '/api/v1/emotions/analyze', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form()
  });
  assert.equal((await send()).status, 200);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
});

test('El adaptador de Rekognition envía bytes y solicita solo EMOTIONS', async () => {
  let request;
  const client = { async send(command, options) {
    request = { command, options };
    return { FaceDetails: [{
      BoundingBox: { Width: 0.5, Height: 0.5 },
      Emotions: [{ Type: 'CONFUSED', Confidence: 80 }, { Type: 'HAPPY', Confidence: 20 }]
    }] };
  } };
  const detector = rekognitionDetector('us-east-1', 5000, client);
  const result = await detector.detect(JPEG);
  assert.deepEqual(request.command.input.Attributes, ['EMOTIONS']);
  assert.deepEqual(Buffer.from(request.command.input.Image.Bytes), JPEG);
  assert.ok(request.options.abortSignal instanceof AbortSignal);
  assert.equal(result.faces, 1);
  assert.equal(result.unsupportedTop, 'CONFUSED');
  assert.deepEqual(result.scores, [{ mood: 'HAPPY', confidence: 20 }]);
});
