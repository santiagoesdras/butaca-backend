import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { HttpFailure } from '../../shared/http.js';
import { mediaTypeSchema, only, tmdbIdText, type Query } from '../../shared/params.js';
import { parse } from '../../shared/validate.js';
import { DEFAULT_MOODS, type MoodCode } from './constants/moods.js';
import type { EmotionDetector } from './detector.js';
import { recommendationInput, type EmotionStore } from './emotions.js';
import { summarize, type SummaryPeriod } from './summary.js';
import { dateInTimeZone } from './utils/date.js';

export const emotionsBase = '/api/v1/emotions';
export type EmotionAnalyzeConfig = { minConfidence?: number; limit?: number; windowMs?: number };
export type EmotionDeps = { store: EmotionStore; detector?: EmotionDetector; analyze?: EmotionAnalyzeConfig };

/** Tamaño máximo de la imagen. Rekognition admite hasta 5 MB por bytes. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/**
 * Confianza mínima (0 a 100) para que /analyze sugiera una emoción. Decisión del equipo: 30, ajustable con
 * EMOTION_MIN_CONFIDENCE. Por debajo, el análisis no sugiere nada y el usuario puede reintentar.
 */
export const MIN_CONFIDENCE = 30;

// ───────── Esquemas de entrada (Zod) ─────────

const moodCodes = DEFAULT_MOODS.map(mood => mood.code) as [MoodCode, ...MoodCode[]];
const moodSchema = z.enum(moodCodes, { error: `mood debe ser ${moodCodes.join(', ')}` });

const timeZoneSchema = z.string({ error: 'time_zone debe ser una zona IANA, por ejemplo America/Guatemala' })
  .min(1).max(64, 'time_zone debe ser una zona IANA, por ejemplo America/Guatemala')
  .refine(value => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
  }, 'time_zone debe ser una zona IANA, por ejemplo America/Guatemala');

/** Mensaje uniforme para objetos con campos de más o que no son objetos. */
const objectError = (issue: { code: string; keys?: string[] }) =>
  issue.code === 'unrecognized_keys' ? 'Campos no admitidos: ' + (issue.keys ?? []).join(', ') : 'Se requiere un objeto JSON';

const consentSchema = z.strictObject({
  policy_version: z.string({ error: 'policy_version es obligatorio (hasta 50 caracteres: letras, números, punto, guion)' })
    .regex(/^[\w.-]{1,50}$/, 'policy_version es obligatorio (hasta 50 caracteres: letras, números, punto, guion)')
}, { error: objectError });

// multer entrega los campos de texto del formulario como un objeto; solo se admite consent="true".
const consentFieldMessage = 'consent debe enviarse exactamente como texto "true"';
const analyzeFieldsSchema = z.strictObject({ consent: z.literal('true', { error: consentFieldMessage }) }, { error: consentFieldMessage });

/** Emoción confirmada por el usuario tras /analyze. La imagen no vuelve a enviarse. */
const confirmedMoodSchema = z.strictObject({
  mood: moodSchema,
  // Confianza que devolvió /analyze para esa misma emoción; se omite si el usuario eligió otra.
  confidence: z.number({ error: 'confidence debe ser un número de 0 a 100 o null' }).min(0, 'confidence debe ser un número de 0 a 100 o null')
    .max(100, 'confidence debe ser un número de 0 a 100 o null').nullish().transform(value => value ?? null),
  time_zone: timeZoneSchema.optional()
}, { error: objectError });

const yearSchema = z.string({ error: 'year debe ser un año de 1970 a 2100' }).regex(/^(19[7-9]\d|20\d{2}|2100)$/, 'year debe ser un año de 1970 a 2100');
const historyQuerySchema = z.object({
  period: z.enum(['7d', '30d'], { error: 'period debe ser 7d o 30d' }).optional(),
  year: yearSchema.optional()
}).refine(query => !(query.period && query.year), 'Usa period o year, no ambos');
const summaryQuerySchema = z.object({
  period: z.enum(['7d', '30d', 'year'], { error: 'period debe ser 7d, 30d o year' }).default('30d')
});

const savedRecommendationParams = z.object({
  id: z.uuid({ error: 'id de registro inválido' }),
  media_type: mediaTypeSchema,
  tmdb_id: tmdbIdText('tmdb_id debe ser un entero entre 1 y 2147483647')
});

// ───────── Rangos de fechas ─────────

const DAY = 86400000;

/** Rango de días locales: `period=7d|30d` (hasta hoy) o `year=YYYY` (año calendario). */
export function historyRange(query: Query, today: Date) {
  only(query, ['period', 'year']);
  const { period, year } = parse(historyQuerySchema, query);
  if (year) return { from: new Date(`${year}-01-01T00:00:00.000Z`), to: new Date(`${year}-12-31T00:00:00.000Z`) };
  const days = period === '7d' ? 7 : 30;
  return { from: new Date(today.getTime() - (days - 1) * DAY), to: today };
}

/** Rango del tablero: 7d/30d hasta hoy, o el año en curso del usuario (1 de enero a hoy). */
export function summaryRange(period: SummaryPeriod, today: Date) {
  if (period === 'year') return { from: new Date(`${today.getUTCFullYear()}-01-01T00:00:00.000Z`), to: today };
  return { from: new Date(today.getTime() - ((period === '7d' ? 7 : 30) - 1) * DAY), to: today };
}

// ───────── Imagen de /analyze ─────────

function realImage(file: Express.Multer.File): Uint8Array {
  const { buffer, mimetype } = file;
  const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.subarray(12, 16).toString('ascii') === 'IHDR';
  if ((mimetype === 'image/jpeg' && !jpeg) || (mimetype === 'image/png' && !png) || (!jpeg && !png)) {
    throw new HttpFailure(415, 'image debe contener una imagen JPEG o PNG válida');
  }
  if ((jpeg && mimetype !== 'image/jpeg') || (png && mimetype !== 'image/png')) {
    throw new HttpFailure(415, 'El tipo declarado de image no coincide con su contenido');
  }
  return new Uint8Array(buffer);
}

export function emotionRoutes(app: Express, { store, detector, analyze = {} }: EmotionDeps) {
  const small = express.json({ limit: '1kb' });
  const noQuery: express.RequestHandler = (req, _res, next) => { only(req.query, []); next(); };
  const user = (res: express.Response) => res.locals.user.id as string;
  const today = async (res: express.Response) => dateInTimeZone(new Date(), await store.timeZone(user(res)));
  const minConfidence = analyze.minConfidence ?? MIN_CONFIDENCE;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 1, parts: 2, fieldNameSize: 50, fieldSize: 16 },
    fileFilter: (_req, file, callback) => {
      if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') return callback(null, true);
      callback(new HttpFailure(415, 'image debe declararse como image/jpeg o image/png'));
    }
  }).single('image');
  const multipart: express.RequestHandler = (req, res, next) => {
    if (!req.is('multipart/form-data')) return next(new HttpFailure(415, 'Se requiere multipart/form-data'));
    upload(req, res, error => {
      if (!error) return next();
      if (error instanceof HttpFailure) return next(error);
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') return next(new HttpFailure(413, 'La imagen supera 2 MB'));
        if (error.code === 'LIMIT_UNEXPECTED_FILE') return next(new HttpFailure(400, 'Se requiere exactamente un archivo image'));
        return next(new HttpFailure(400, 'Formulario multipart inválido'));
      }
      next(new HttpFailure(400, 'Formulario multipart inválido'));
    });
  };
  const analyzeLimit = rateLimit({
    windowMs: analyze.windowMs ?? 60000,
    limit: analyze.limit ?? 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (_req, res) => String(res.locals.user.id),
    message: { error: 'Demasiados análisis; inténtalo más tarde' }
  });

  // Análisis efímero: la imagen se envía a Rekognition y se descarta. No escribe historial.
  // Es la única ruta que recibe imágenes; el registro se hace después con POST /history.
  app.post(emotionsBase + '/analyze', noQuery, analyzeLimit, multipart, async (req, res) => {
    parse(analyzeFieldsSchema, req.body ?? {});
    if (!req.file) throw new HttpFailure(400, 'Se requiere exactamente un archivo image');
    const image = realImage(req.file);
    if (!detector) throw new HttpFailure(503, 'La detección de emociones no está configurada');
    const result = await detector.detect(image);
    if (result.faces === 0) throw new HttpFailure(422, 'No se detectó ningún rostro en la imagen');
    if (result.faces > 1) throw new HttpFailure(422, 'Se detectó más de un rostro; envía una imagen con una sola persona');

    const top = result.scores[0];
    const unsupported = result.unsupportedTop !== undefined;
    const sufficient = !!top && top.confidence >= minConfidence;
    res.json({
      suggestedExpression: !unsupported && sufficient ? top.mood : null,
      confidence: !unsupported && sufficient ? top.confidence : null,
      confirmationRequired: true,
      faces: result.faces,
      reason: unsupported ? 'unsupported_expression' : sufficient ? null : 'insufficient_confidence'
    });
  });

  // Consentimiento explícito para usar la cámara (tabla camera_consents).
  app.get(emotionsBase + '/consent', noQuery, async (_req, res) => {
    res.json(await store.consent(user(res)));
  });
  app.put(emotionsBase + '/consent', noQuery, small, async (req, res) => {
    const { policy_version } = parse(consentSchema, req.body ?? {});
    res.json(await store.grant(user(res), policy_version));
  });
  app.delete(emotionsBase + '/consent', noQuery, async (_req, res) => {
    await store.revoke(user(res));
    res.status(204).end();
  });

  // Registro de la emoción confirmada: un registro por usuario y día local; confirmar otra vez el mismo
  // día lo reemplaza y conserva sus recomendaciones guardadas. No recibe imágenes.
  app.post(emotionsBase + '/history', noQuery, small, async (req, res) => {
    const { mood, confidence, time_zone } = parse(confirmedMoodSchema, req.body);
    if (!(await store.consent(user(res))).granted) throw new HttpFailure(403, 'Se requiere el consentimiento para usar la cámara');
    if (time_zone) await store.setTimeZone(user(res), time_zone);
    const detectedAt = new Date();
    const date = dateInTimeZone(detectedAt, time_zone ?? await store.timeZone(user(res)));
    const { entry, replaced } = await store.record(user(res), {
      date, detectedAt, mood,
      scores: confidence === null ? [] : [{ mood, confidence }],
      source: confidence === null ? 'USER_SELECTED' : 'AWS_REKOGNITION'
    });
    res.status(replaced ? 200 : 201).json({ ...entry, replaced });
  });

  app.get(emotionsBase + '/history', async (req, res) => {
    const { from, to } = historyRange(req.query, await today(res));
    res.json({ results: await store.history(user(res), from, to) });
  });

  // Datos agregados para el tablero.
  app.get(emotionsBase + '/summary', async (req, res) => {
    only(req.query, ['period']);
    const { period } = parse(summaryQuerySchema, req.query);
    const { from, to } = summaryRange(period, await today(res));
    res.json(summarize(await store.history(user(res), from, to), period, from, to));
  });

  // Guarda una película o serie recomendada a partir de un registro de emoción.
  app.put(emotionsBase + '/history/:id/recommendations/:media_type/:tmdb_id', noQuery, express.json({ limit: '8kb' }), async (req, res) => {
    const { id, media_type, tmdb_id } = parse(savedRecommendationParams, req.params);
    res.json(await store.saveRecommendation(user(res), id, { media_type, tmdb_id }, recommendationInput(req.body)));
  });
}
