import test from 'node:test';
import assert from 'node:assert/strict';
import { dateInTimeZone } from '../dist/library-service/src/utils/date.js';
import {
  toPrismaMediaType,
  toApiMediaType,
  toPrismaProgressStatus,
  toApiProgressStatus,
} from '../dist/library-service/src/dtos/media.dto.js';
import { MediaType, ProgressStatus, DEFAULT_MOODS } from '../dist/library-service/src/db.js';

test('Library DB - Cálculo de dateInTimeZone por zona horaria de usuario (db.md Sec. C)', () => {
  // 2026-11-10 a las 02:30:00 UTC
  // En Tokio (UTC+9) es 2026-11-10 11:30
  // En Guatemala (UTC-6) es 2026-11-09 20:30
  const instant = new Date('2026-11-10T02:30:00.000Z');

  const tokyoDate = dateInTimeZone(instant, 'Asia/Tokyo');
  assert.equal(tokyoDate.toISOString(), '2026-11-10T00:00:00.000Z');

  const guatemalaDate = dateInTimeZone(instant, 'America/Guatemala');
  assert.equal(guatemalaDate.toISOString(), '2026-11-09T00:00:00.000Z');

  const defaultUtcDate = dateInTimeZone(instant);
  assert.equal(defaultUtcDate.toISOString(), '2026-11-10T00:00:00.000Z');
});

test('Library DB - Transformación de DTOs y Enums (db.md Sec. F)', () => {
  // MediaType
  assert.equal(toPrismaMediaType('movie'), MediaType.MOVIE);
  assert.equal(toPrismaMediaType('tv'), MediaType.TV);
  assert.equal(toApiMediaType(MediaType.MOVIE), 'movie');
  assert.equal(toApiMediaType(MediaType.TV), 'tv');
  assert.throws(() => toPrismaMediaType('invalid'), /Tipo de medio inválido/);

  // ProgressStatus
  assert.equal(toPrismaProgressStatus('in_progress'), ProgressStatus.IN_PROGRESS);
  assert.equal(toPrismaProgressStatus('completed'), ProgressStatus.COMPLETED);
  assert.equal(toPrismaProgressStatus('on_hold'), ProgressStatus.ON_HOLD);
  assert.equal(toPrismaProgressStatus('dropped'), ProgressStatus.DROPPED);

  assert.equal(toApiProgressStatus(ProgressStatus.IN_PROGRESS), 'in_progress');
  assert.equal(toApiProgressStatus(ProgressStatus.COMPLETED), 'completed');
  assert.equal(toApiProgressStatus(ProgressStatus.ON_HOLD), 'on_hold');
  assert.equal(toApiProgressStatus(ProgressStatus.DROPPED), 'dropped');
  assert.throws(() => toPrismaProgressStatus('unknown'), /Estado de progreso inválido/);
});

test('Library DB - Catálogo de emociones para Seed (db.md Sec. H)', () => {
  assert.equal(DEFAULT_MOODS.length, 7);
  const codes = DEFAULT_MOODS.map(m => m.code);
  assert.deepEqual(codes, [
    'HAPPY',
    'SAD',
    'ANGRY',
    'FEAR',
    'DISGUSTED',
    'SURPRISED',
    'CALM',
  ]);
});
