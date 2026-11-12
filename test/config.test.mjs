import test from 'node:test';
import assert from 'node:assert/strict';
import { envInteger, httpUrl, loadConfig, optionalHttpUrl, optionalText, positiveInteger, postgresUrl, requiredText, textWithDefault }
  from '../dist/shared/config.js';

test('Configuración con Zod: obligatorias, predeterminados y errores claros', () => {
  const shape = {
    TMDB_READ_ACCESS_TOKEN: requiredText,
    SUPABASE_URL: httpUrl(),
    MEDIA_ORIGIN: httpUrl('http://127.0.0.1:3001'),
    LIBRARY_ORIGIN: optionalHttpUrl,
    AWS_REGION: optionalText,
    DATABASE_URL: postgresUrl,
    CACHE_TTL_MS: positiveInteger(300000),
    EMOTION_MIN_CONFIDENCE: positiveInteger(30, 100),
    SUPABASE_JWT_AUDIENCE: textWithDefault('authenticated')
  };
  const valid = {
    TMDB_READ_ACCESS_TOKEN: 'token-secreto', SUPABASE_URL: 'https://proyecto.supabase.co',
    DATABASE_URL: 'postgresql://usuario:clave@host:5432/db', AWS_REGION: '', SUPABASE_JWT_AUDIENCE: ''
  };

  // Valores predeterminados y cadenas vacías (como las que entrega Docker Compose con ${VAR:-}).
  const config = loadConfig(shape, valid);
  assert.equal(config.MEDIA_ORIGIN, 'http://127.0.0.1:3001');
  assert.equal(config.LIBRARY_ORIGIN, undefined);
  assert.equal(config.AWS_REGION, undefined, 'vacío equivale a ausente');
  assert.equal(config.CACHE_TTL_MS, 300000);
  assert.equal(config.EMOTION_MIN_CONFIDENCE, 30);
  assert.equal(config.SUPABASE_JWT_AUDIENCE, 'authenticated');
  assert.equal(loadConfig(shape, { ...valid, CACHE_TTL_MS: '60000' }).CACHE_TTL_MS, 60000, 'convierte texto a número');

  // Cada variable inválida aparece en el mensaje, sin mostrar su valor.
  const broken = { ...valid, TMDB_READ_ACCESS_TOKEN: '  ', SUPABASE_URL: 'ftp://x', DATABASE_URL: 'mysql://usuario:clave-secreta@h/db',
    CACHE_TTL_MS: '-5', EMOTION_MIN_CONFIDENCE: '101', LIBRARY_ORIGIN: 'no-es-url' };
  assert.throws(() => loadConfig(shape, broken), error => {
    for (const name of ['TMDB_READ_ACCESS_TOKEN', 'SUPABASE_URL', 'DATABASE_URL', 'CACHE_TTL_MS', 'EMOTION_MIN_CONFIDENCE', 'LIBRARY_ORIGIN']) {
      assert.match(error.message, new RegExp(name), name);
    }
    assert.doesNotMatch(error.message, /clave-secreta/, 'no filtra secretos');
    return true;
  });
  assert.throws(() => loadConfig(shape, {}), /TMDB_READ_ACCESS_TOKEN: es obligatoria/);

  // Lectura individual usada por los servicios al construirse.
  process.env.BUTACA_TEST_INTEGER = '42';
  assert.equal(envInteger('BUTACA_TEST_INTEGER', 7), 42);
  delete process.env.BUTACA_TEST_INTEGER;
  assert.equal(envInteger('BUTACA_TEST_INTEGER', 7), 7);
});
