import type { Prisma, PrismaClient, ProgressStatus } from '../generated/prisma/client.js';
import { HttpFailure } from '../../shared/http.js';
import { toApiMediaType, toApiProgressStatus, toPrismaMediaType, toPrismaProgressStatus, type ApiProgressStatus } from './dtos/media.dto.js';
import type { MediaRef } from './watchlist.js';

export type ProgressInput = { status: ApiProgressStatus; position_seconds: number | null; duration_seconds: number | null };
export type EpisodeRef = { season: number; episode: number };
type Row = { tmdbId: number; mediaType: 'MOVIE' | 'TV'; status: ProgressStatus; positionSeconds: number | null;
  durationSeconds: number | null; updatedAt: Date;
  episodes: { seasonNumber: number; episodeNumber: number; watchedAt: Date }[] };
export type ProgressEntry = ReturnType<typeof serialize>;
export interface ProgressStore {
  list(user: string): Promise<ProgressEntry[]>;
  set(user: string, ref: MediaRef, input: ProgressInput): Promise<ProgressEntry>;
  markEpisode(user: string, ref: MediaRef, episode: EpisodeRef): Promise<ProgressEntry>;
  removeEpisode(user: string, ref: MediaRef, episode: EpisodeRef): Promise<void>;
}

export function progressInput(body: unknown, ref: MediaRef): ProgressInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpFailure(400, 'Se requiere un objeto JSON de progreso');
  const values = body as Record<string, unknown>;
  if (Object.keys(values).some(key => !['status', 'position_seconds', 'duration_seconds'].includes(key))) {
    throw new HttpFailure(400, 'Campos de progreso no admitidos');
  }
  if (typeof values.status !== 'string' || !['in_progress', 'completed', 'on_hold', 'dropped'].includes(values.status)) throw new HttpFailure(400, 'Estado de progreso inválido');
  const integer = (key: string, min: number) => {
    const value = values[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 2147483647) {
      throw new HttpFailure(400, `${key} debe ser un entero entre ${min} y 2147483647, o null`);
    }
    return value;
  };
  const position = integer('position_seconds', 0);
  const duration = integer('duration_seconds', 1);
  if (ref.media_type === 'tv' && (position !== null || duration !== null)) throw new HttpFailure(400, 'En series el avance se registra por episodios');
  if (position !== null && duration !== null && position > duration) throw new HttpFailure(400, 'La posición no puede superar la duración');
  return { status: values.status as ApiProgressStatus, position_seconds: position, duration_seconds: duration };
}

function serialize(item: Row) {
  return { tmdb_id: item.tmdbId, media_type: toApiMediaType(item.mediaType), status: toApiProgressStatus(item.status),
    position_seconds: item.positionSeconds, duration_seconds: item.durationSeconds, updated_at: item.updatedAt.toISOString(),
    episodes: item.episodes.map(episode => ({ season: episode.seasonNumber, episode: episode.episodeNumber, watched_at: episode.watchedAt.toISOString() })) };
}

export function progressStore(db: PrismaClient): ProgressStore {
  const select = { tmdbId: true, mediaType: true, status: true, positionSeconds: true, durationSeconds: true, updatedAt: true,
    episodes: { select: { seasonNumber: true, episodeNumber: true, watchedAt: true }, orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }] } } satisfies Prisma.ProgressSelect;
  const identity = (profileId: string, ref: MediaRef) => ({ profileId, tmdbId: ref.tmdb_id, mediaType: toPrismaMediaType(ref.media_type) });
  return {
    async list(user) {
      return (await db.progress.findMany({ where: { profileId: user }, select, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] })).map(serialize);
    },
    async set(user, ref, input) {
      const where = identity(user, ref);
      const data = { status: toPrismaProgressStatus(input.status), positionSeconds: input.position_seconds, durationSeconds: input.duration_seconds };
      return serialize(await db.progress.upsert({ where: { profileId_tmdbId_mediaType: where }, create: { ...where, ...data }, update: data, select }));
    },
    async markEpisode(user, ref, episode) {
      return db.$transaction(async tx => {
        const where = identity(user, ref);
        await tx.progress.createMany({ data: where, skipDuplicates: true });
        const parent = await tx.progress.findUniqueOrThrow({ where: { profileId_tmdbId_mediaType: where }, select: { id: true } });
        await tx.progressEpisode.createMany({ data: { progressId: parent.id, profileId: user,
          seasonNumber: episode.season, episodeNumber: episode.episode }, skipDuplicates: true });
        return serialize(await tx.progress.update({ where: { profileId_tmdbId_mediaType: where }, data: { updatedAt: new Date() }, select }));
      });
    },
    async removeEpisode(user, ref, episode) {
      await db.$transaction(async tx => {
        const where = identity(user, ref);
        const parent = await tx.progress.findUnique({ where: { profileId_tmdbId_mediaType: where }, select: { id: true } });
        if (!parent) return;
        const result = await tx.progressEpisode.deleteMany({ where: { profileId: user, progressId: parent.id,
          seasonNumber: episode.season, episodeNumber: episode.episode } });
        if (result.count) await tx.progress.update({ where: { profileId_tmdbId_mediaType: where }, data: { updatedAt: new Date() } });
      });
    }
  };
}
