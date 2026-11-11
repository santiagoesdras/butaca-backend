import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { HttpFailure } from '../../shared/http.js';
import { only, type Query } from '../../shared/params.js';
import type { EmotionDetector } from './detector.js';
import { recommendationInput, type EmotionStore } from './emotions.js';
import { dateInTimeZone } from './utils/date.js';

export const emotionsBase = '/api/v1/emotions';
export type EmotionAnalyzeConfig = { minConfidence?: number; limit?: number; windowMs?: number };
export type EmotionDeps = { store: EmotionStore; detector?: EmotionDetector; analyze?: EmotionAnalyzeConfig };

/** Tamaño máximo de la imagen ya decodificada. Rekognition admite hasta 5 MB por bytes. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Confianza mínima (0 a 100) de la emoción principal para registrarla. */
export const MIN_CONFIDENCE = 30;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string) => new HttpFailure(400, message);

function object(body: unknown, allowed: string[]) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Se requiere un objeto JSON');
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw invalid('Campos no admitidos: ' + unknown.join(', '));
  return body as Record<string, unknown>;
}

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

/** Acepta base64 o un data URL de JPEG/PNG y comprueba el formato real por sus primeros bytes. */
export function decodeImage(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value) throw invalid('image es obligatorio (JPEG o PNG en base64)');
  const match = /^(?:data:image\/(?:jpeg|png);base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new HttpFailure(415, 'image debe ser JPEG o PNG codificada en base64');
  const bytes = Buffer.from(match[1]!, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpFailure(413, 'La imagen supera 2 MB');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!jpeg && !png) throw new HttpFailure(415, 'image debe ser JPEG o PNG codificada en base64');
  return new Uint8Array(bytes);
}

export function timeZoneOf(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) throw invalid('time_zone debe ser una zona IANA, por ejemplo America/Guatemala');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw invalid('time_zone debe ser una zona IANA, por ejemplo America/Guatemala');
  }
  return value;
}

/** Rango de fechas locales: `period=7d|30d` (hasta hoy) o `year=YYYY` (año calendario). */
export function historyRange(query: Query, today: Date) {
  only(query, ['period', 'year']);
  const { period, year } = query;
  if (period !== undefined && year !== undefined) throw invalid('Usa period o year, no ambos');
  if (year !== undefined) {
    if (typeof year !== 'string' || !/^(19[7-9]\d|20\d{2}|2100)$/.test(year)) throw invalid('year debe ser un año de 1970 a 2100');
    return { from: new Date(`${year}-01-01T00:00:00.000Z`), to: new Date(`${year}-12-31T00:00:00.000Z`) };
  }
  const value = period ?? '30d';
  if (value !== '7d' && value !== '30d') throw invalid('period debe ser 7d o 30d');
  const days = value === '7d' ? 7 : 30;
  return { from: new Date(today.getTime() - (days - 1) * 86400000), to: today };
}

export function emotionRoutes(app: Express, { store, detector, analyze = {} }: EmotionDeps) {
  const small = express.json({ limit: '1kb' });
  const noQuery: express.RequestHandler = (req, _res, next) => { only(req.query, []); next(); };
  const user = (res: express.Response) => res.locals.user.id as string;
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

  // Análisis efímero para Frontend: no consulta ni escribe historial, consentimiento o perfiles.
  app.post(emotionsBase + '/analyze', noQuery, analyzeLimit, multipart, async (req, res) => {
    const fields = object(req.body ?? {}, ['consent']);
    if (Object.keys(fields).length !== 1 || fields.consent !== 'true') {
      throw invalid('consent debe enviarse exactamente como texto "true"');
    }
    if (!req.file) throw invalid('Se requiere exactamente un archivo image');
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
    const { policy_version } = object(req.body ?? {}, ['policy_version']);
    if (typeof policy_version !== 'string' || !/^[\w.-]{1,50}$/.test(policy_version)) {
      throw invalid('policy_version es obligatorio (hasta 50 caracteres: letras, números, punto, guion)');
    }
    res.json(await store.grant(user(res), policy_version));
  });
  app.delete(emotionsBase + '/consent', noQuery, async (_req, res) => {
    await store.revoke(user(res));
    res.status(204).end();
  });

  // Detección: la imagen se analiza y se descarta; solo se guardan la emoción y sus puntajes.
  app.post(emotionsBase + '/detections', noQuery, express.json({ limit: '3mb' }), async (req, res) => {
    const body = object(req.body, ['image', 'time_zone']);
    const image = decodeImage(body.image);
    const zone = body.time_zone === undefined ? undefined : timeZoneOf(body.time_zone);
    if (!detector) throw new HttpFailure(503, 'La detección de emociones no está configurada');
    if (!(await store.consent(user(res))).granted) throw new HttpFailure(403, 'Se requiere el consentimiento para usar la cámara');
    const result = await detector.detect(image);
    if (result.faces === 0) throw new HttpFailure(422, 'No se detectó ningún rostro en la imagen');
    if (result.unsupportedTop) throw new HttpFailure(422, 'La expresión principal no pertenece al catálogo de Butaca');
    const top = result.scores[0];
    if (!top || top.confidence < MIN_CONFIDENCE) throw new HttpFailure(422, 'No fue posible determinar la emoción con suficiente confianza');
    if (zone) await store.setTimeZone(user(res), zone);
    const detectedAt = new Date();
    const date = dateInTimeZone(detectedAt, zone ?? await store.timeZone(user(res)));
    const { entry, replaced } = await store.record(user(res), { date, detectedAt, scores: result.scores });
    res.status(replaced ? 200 : 201).json({ ...entry, faces: result.faces, replaced });
  });

  app.get(emotionsBase + '/history', async (req, res) => {
    const today = dateInTimeZone(new Date(), await store.timeZone(user(res)));
    const { from, to } = historyRange(req.query, today);
    res.json({ results: await store.history(user(res), from, to) });
  });

  // Guarda una película o serie recomendada a partir de un registro de emoción.
  app.put(emotionsBase + '/history/:id/recommendations/:media_type/:tmdb_id', noQuery, express.json({ limit: '8kb' }), async (req, res) => {
    const { id, media_type, tmdb_id } = req.params;
    if (!uuid.test(String(id))) throw invalid('id de registro inválido');
    if (media_type !== 'movie' && media_type !== 'tv') throw invalid('media_type debe ser movie o tv');
    if (!/^[1-9]\d{0,9}$/.test(String(tmdb_id)) || Number(tmdb_id) > 2147483647) throw invalid('tmdb_id debe ser un entero entre 1 y 2147483647');
    res.json(await store.saveRecommendation(user(res), String(id), { media_type, tmdb_id: Number(tmdb_id) }, recommendationInput(req.body)));
  });
}
