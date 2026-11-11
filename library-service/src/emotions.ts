import type { PrismaClient } from '../generated/prisma/client.js';
import { HttpFailure } from '../../shared/http.js';
import { DEFAULT_MOODS, type MoodCode } from './constants/moods.js';
import type { MoodScore } from './detector.js';
import { toApiMediaType, toPrismaMediaType, type ApiMediaType } from './dtos/media.dto.js';

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
  confidence: number;
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
  record(profileId: string, input: { date: Date; detectedAt: Date; scores: MoodScore[] }): Promise<{ entry: HistoryEntry; replaced: boolean }>;
  history(profileId: string, from: Date, to: Date): Promise<HistoryEntry[]>;
  saveRecommendation(profileId: string, historyId: string, ref: { tmdb_id: number; media_type: ApiMediaType },
    input: RecommendationInput): Promise<SavedRecommendation>;
}

const NAMES = new Map<string, string>(DEFAULT_MOODS.map(mood => [mood.code, mood.name]));
const day = (date: Date) => date.toISOString().slice(0, 10);

// ───────── Validación del cuerpo de una recomendación guardada ─────────

export function recommendationInput(body: unknown): RecommendationInput {
  const invalid = (message: string) => new HttpFailure(400, message);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Se requiere un objeto JSON');
  const values = body as Record<string, unknown>;
  const allowed = ['title', 'poster_path', 'overview', 'release_date', 'vote_average', 'genre_ids'];
  const unknown = Object.keys(values).filter(key => !allowed.includes(key));
  if (unknown.length) throw invalid('Campos no admitidos: ' + unknown.join(', '));
  const text = (name: string, max: number) => {
    const value = values[name] ?? null;
    if (value !== null && (typeof value !== 'string' || value.length > max)) throw invalid(`${name} debe ser texto de hasta ${max} caracteres o null`);
    return value as string | null;
  };
  const title = text('title', 255);
  if (!title || !title.trim()) throw invalid('title es obligatorio');
  const release = text('release_date', 10);
  if (release !== null && !/^\d{4}-\d{2}-\d{2}$/.test(release)) throw invalid('release_date debe tener formato YYYY-MM-DD');
  const vote = values.vote_average ?? null;
  if (vote !== null && (typeof vote !== 'number' || !Number.isFinite(vote) || vote < 0 || vote > 10)) {
    throw invalid('vote_average debe ser un número de 0 a 10 o null');
  }
  const genres = values.genre_ids ?? [];
  if (!Array.isArray(genres) || genres.length > 20 || !genres.every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)) {
    throw invalid('genre_ids debe ser una lista de hasta 20 enteros positivos');
  }
  return {
    title: title.trim(), poster_path: text('poster_path', 500), overview: text('overview', 4000), release_date: release,
    vote_average: vote === null ? null : Math.round(vote * 10) / 10, genre_ids: genres as number[]
  };
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
  id: string; detectionDate: Date; detectedAt: Date; primaryMoodCode: string;
  scores: { moodCode: string; confidence: { toString(): string } }[];
  savedRecommendations: SavedRow[];
};
const entry = (row: HistoryRow): HistoryEntry => {
  const scores = row.scores.map(score => ({ mood: score.moodCode as MoodCode, confidence: Number(score.confidence) }))
    .sort((a, b) => b.confidence - a.confidence);
  return {
    id: row.id, date: day(row.detectionDate), mood: row.primaryMoodCode as MoodCode, name: NAMES.get(row.primaryMoodCode) ?? row.primaryMoodCode,
    confidence: scores.find(score => score.mood === row.primaryMoodCode)?.confidence ?? 0, scores,
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
    async record(profileId, { date, detectedAt, scores }) {
      const primary = scores[0]!;
      return db.$transaction(async tx => {
        const existing = await tx.moodHistory.findUnique({
          where: { profileId_detectionDate: { profileId, detectionDate: date } }, select: { id: true }
        });
        const data = { primaryMoodCode: primary.mood, detectedAt, source: 'AWS_REKOGNITION' };
        const history = existing
          ? await tx.moodHistory.update({ where: { id: existing.id }, data, select: { id: true } })
          : await tx.moodHistory.create({ data: { ...data, profileId, detectionDate: date }, select: { id: true } });
        if (existing) await tx.moodHistoryScore.deleteMany({ where: { moodHistoryId: history.id } });
        await tx.moodHistoryScore.createMany({
          data: scores.map(score => ({ moodHistoryId: history.id, moodCode: score.mood, confidence: score.confidence }))
        });
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
