import type { Prisma, PrismaClient, ProgressStatus } from '../generated/prisma/client.js';
import { z } from 'zod';
import { HttpFailure } from '../../shared/http.js';
import { parse } from '../../shared/validate.js';
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

const seconds = (key: string, min: number) => z.number({ error: `${key} debe ser un entero entre ${min} y 2147483647, o null` })
  .int(`${key} debe ser un entero entre ${min} y 2147483647, o null`)
  .min(min, `${key} debe ser un entero entre ${min} y 2147483647, o null`)
  .max(2147483647, `${key} debe ser un entero entre ${min} y 2147483647, o null`)
  .nullish().transform(value => value ?? null);

const progressSchema = z.strictObject({
  status: z.enum(['in_progress', 'completed', 'on_hold', 'dropped'], { error: 'Estado de progreso inválido' }),
  position_seconds: seconds('position_seconds', 0),
  duration_seconds: seconds('duration_seconds', 1)
}, { error: issue => issue.code === 'unrecognized_keys' ? 'Campos de progreso no admitidos' : 'Se requiere un objeto JSON de progreso' });

export function progressInput(body: unknown, ref: MediaRef): ProgressInput {
  const input: ProgressInput = parse(progressSchema, body);
  if (ref.media_type === 'tv' && (input.position_seconds !== null || input.duration_seconds !== null)) {
    throw new HttpFailure(400, 'En series el avance se registra por episodios');
  }
  if (input.position_seconds !== null && input.duration_seconds !== null && input.position_seconds > input.duration_seconds) {
    throw new HttpFailure(400, 'La posición no puede superar la duración');
  }
  return input;
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
