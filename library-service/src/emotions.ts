import type { PrismaClient } from '../generated/prisma/client.js';
import { z } from 'zod';
import { HttpFailure } from '../../shared/http.js';
import { parse } from '../../shared/validate.js';
import { DEFAULT_MOODS, type MoodCode } from './constants/moods.js';
import type { MoodScore } from './detector.js';
import { toApiMediaType, toPrismaMediaType, type ApiMediaType } from './dtos/media.dto.js';

/** Registro de la emoción confirmada por el usuario para su día local. */
export type RecordInput = { date: Date; detectedAt: Date; mood: MoodCode; scores: MoodScore[]; source: 'AWS_REKOGNITION' | 'USER_SELECTED' };

export type Consent = { granted: boolean; policy_version: string | null; granted_at: string | null };

export type SavedRecommendation = {
  tmdb_id: number; media_type: ApiMediaType; title: string; poster_path: string | null; overview: string | null;
  release_date: string | null; vote_average: number | null; genre_ids: number[]; saved_at: string;
};
export type RecommendationInput = Omit<SavedRecommendation, 'tmdb_id' | 'media_type' | 'saved_at'>;

export type HistoryEntry = {
  id: string;
  /** Día local del usuario (YYYY-MM-DD). */
  date: string;
  mood: MoodCode;
  name: string;
  /** Confianza del análisis (0 a 100) o null si el usuario eligió la emoción sin análisis. */
  confidence: number | null;
  /** AWS_REKOGNITION: emoción sugerida por el análisis y confirmada; USER_SELECTED: elegida por el usuario. */
  source: string;
  scores: MoodScore[];
  detected_at: string;
  recommendations: SavedRecommendation[];
};

export interface EmotionStore {
  consent(profileId: string): Promise<Consent>;
  grant(profileId: string, policyVersion: string): Promise<Consent>;
  revoke(profileId: string): Promise<void>;
  timeZone(profileId: string): Promise<string>;
  setTimeZone(profileId: string, timeZone: string): Promise<void>;
  /** Guarda la detección del día; si ya había una ese día, la reemplaza (una por usuario y día). */
  record(profileId: string, input: RecordInput): Promise<{ entry: HistoryEntry; replaced: boolean }>;
  history(profileId: string, from: Date, to: Date): Promise<HistoryEntry[]>;
  saveRecommendation(profileId: string, historyId: string, ref: { tmdb_id: number; media_type: ApiMediaType },
    input: RecommendationInput): Promise<SavedRecommendation>;
}

const NAMES = new Map<string, string>(DEFAULT_MOODS.map(mood => [mood.code, mood.name]));
const day = (date: Date) => date.toISOString().slice(0, 10);

// ───────── Validación del cuerpo de una recomendación guardada ─────────

const genreMessage = 'genre_ids debe ser una lista de hasta 20 enteros positivos';
const nullableText = (name: string, max: number) =>
  z.string({ error: `${name} debe ser texto de hasta ${max} caracteres o null` })
    .max(max, `${name} debe ser texto de hasta ${max} caracteres o null`).nullish().transform(value => value ?? null);

export const recommendationSchema = z.strictObject({
  title: z.string({ error: 'title es obligatorio' }).max(255, 'title debe ser texto de hasta 255 caracteres o null').trim()
    .min(1, 'title es obligatorio'),
  poster_path: nullableText('poster_path', 500),
  overview: nullableText('overview', 4000),
  release_date: z.string({ error: 'release_date debe tener formato YYYY-MM-DD' }).regex(/^\d{4}-\d{2}-\d{2}$/,'release_date debe tener formato YYYY-MM-DD')
    .nullish().transform(value => value ?? null),
  vote_average: z.number({ error: 'vote_average debe ser un número de 0 a 10 o null' }).min(0, 'vote_average debe ser un número de 0 a 10 o null')
    .max(10, 'vote_average debe ser un número de 0 a 10 o null').nullish().transform(value => value === null || value === undefined ? null : Math.round(value * 10) / 10),
  genre_ids: z.array(z.number({ error: genreMessage }).int(genreMessage).min(1, genreMessage).max(2147483647, genreMessage), { error: genreMessage })
    .max(20, genreMessage).default([])
}, { error: issue => issue.code === 'unrecognized_keys' ? 'Campos no admitidos: ' + issue.keys.join(', ') : 'Se requiere un objeto JSON' });

export function recommendationInput(body: unknown): RecommendationInput {
  return parse(recommendationSchema, body);
}

// ───────── Implementación con Prisma ─────────

type Db = Pick<PrismaClient, 'cameraConsent' | 'profile' | 'moodHistory' | 'moodHistoryScore' | 'savedRecommendation' | '$transaction'>;

type SavedRow = {
  tmdbId: number; mediaType: Parameters<typeof toApiMediaType>[0]; title: string; posterPath: string | null; overview: string | null;
  releaseDate: string | null; voteAverage: { toString(): string } | null; genreIds: number[]; savedAt: Date;
};
const saved = (row: SavedRow): SavedRecommendation => ({
  tmdb_id: row.tmdbId, media_type: toApiMediaType(row.mediaType), title: row.title, poster_path: row.posterPath,
  overview: row.overview, release_date: row.releaseDate, vote_average: row.voteAverage === null ? null : Number(row.voteAverage),
  genre_ids: row.genreIds, saved_at: row.savedAt.toISOString()
});

type HistoryRow = {
  id: string; detectionDate: Date; detectedAt: Date; primaryMoodCode: string; source: string;
  scores: { moodCode: string; confidence: { toString(): string } }[];
  savedRecommendations: SavedRow[];
};
const entry = (row: HistoryRow): HistoryEntry => {
  const scores = row.scores.map(score => ({ mood: score.moodCode as MoodCode, confidence: Number(score.confidence) }))
    .sort((a, b) => b.confidence - a.confidence);
  return {
    id: row.id, date: day(row.detectionDate), mood: row.primaryMoodCode as MoodCode, name: NAMES.get(row.primaryMoodCode) ?? row.primaryMoodCode,
    confidence: scores.find(score => score.mood === row.primaryMoodCode)?.confidence ?? null, source: row.source, scores,
    detected_at: row.detectedAt.toISOString(), recommendations: row.savedRecommendations.map(saved)
  };
};

const include = {
  scores: { select: { moodCode: true, confidence: true } },
  savedRecommendations: { orderBy: { savedAt: 'desc' } }
} as const;

// Todas las consultas incluyen el usuario obtenido del JWT.
export function emotionStore(db: Db): EmotionStore {
  return {
    async consent(profileId) {
      const row = await db.cameraConsent.findUnique({ where: { profileId } });
      const granted = !!row && row.revokedAt === null;
      return { granted, policy_version: granted ? row.policyVersion : null, granted_at: granted ? row.grantedAt.toISOString() : null };
    },
    async grant(profileId, policyVersion) {
      const row = await db.cameraConsent.upsert({
        where: { profileId },
        create: { profileId, policyVersion },
        update: { policyVersion, grantedAt: new Date(), revokedAt: null }
      });
      return { granted: true, policy_version: row.policyVersion, granted_at: row.grantedAt.toISOString() };
    },
    async revoke(profileId) {
      await db.cameraConsent.updateMany({ where: { profileId, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    async timeZone(profileId) {
      return (await db.profile.findUnique({ where: { id: profileId }, select: { timeZone: true } }))?.timeZone ?? 'UTC';
    },
    async setTimeZone(profileId, timeZone) {
      await db.profile.updateMany({ where: { id: profileId }, data: { timeZone } });
    },
    async record(profileId, { date, detectedAt, mood, scores, source }) {
      return db.$transaction(async tx => {
        const existing = await tx.moodHistory.findUnique({
          where: { profileId_detectionDate: { profileId, detectionDate: date } }, select: { id: true }
        });
        const data = { primaryMoodCode: mood, detectedAt, source };
        const history = existing
          ? await tx.moodHistory.update({ where: { id: existing.id }, data, select: { id: true } })
          : await tx.moodHistory.create({ data: { ...data, profileId, detectionDate: date }, select: { id: true } });
        if (existing) await tx.moodHistoryScore.deleteMany({ where: { moodHistoryId: history.id } });
        if (scores.length) {
          await tx.moodHistoryScore.createMany({
            data: scores.map(score => ({ moodHistoryId: history.id, moodCode: score.mood, confidence: score.confidence }))
          });
        }
        const row = await tx.moodHistory.findFirstOrThrow({ where: { id: history.id, profileId }, include });
        return { entry: entry(row), replaced: !!existing };
      });
    },
    async history(profileId, from, to) {
      const rows = await db.moodHistory.findMany({
        where: { profileId, detectionDate: { gte: from, lte: to } }, include, orderBy: { detectionDate: 'asc' }
      });
      return rows.map(entry);
    },
    async saveRecommendation(profileId, historyId, ref, input) {
      return db.$transaction(async tx => {
        const history = await tx.moodHistory.findFirst({ where: { id: historyId, profileId }, select: { primaryMoodCode: true, detectedAt: true } });
        if (!history) throw new HttpFailure(404, 'Registro de emoción no encontrado');
        const mediaType = toPrismaMediaType(ref.media_type);
        const values = {
          title: input.title, posterPath: input.poster_path, overview: input.overview, releaseDate: input.release_date,
          voteAverage: input.vote_average, genreIds: input.genre_ids
        };
        const row = await tx.savedRecommendation.upsert({
          where: { moodHistoryId_tmdbId_mediaType: { moodHistoryId: historyId, tmdbId: ref.tmdb_id, mediaType } },
          create: {
            ...values, profileId, moodHistoryId: historyId, tmdbId: ref.tmdb_id, mediaType,
            moodCodeAtSave: history.primaryMoodCode, moodDetectedAt: history.detectedAt
          },
          update: values
        });
        return saved(row);
      });
    }
  };
}
