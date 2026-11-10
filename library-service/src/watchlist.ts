import type { PrismaClient } from '../generated/prisma/client.js';
import { toApiMediaType, toApiProgressStatus, toPrismaMediaType, type ApiMediaType } from './dtos/media.dto.js';

export type MediaRef = { tmdb_id: number; media_type: ApiMediaType };
export type WatchlistEntry = MediaRef & {
  created_at: string;
  status: 'pending' | ReturnType<typeof toApiProgressStatus>;
};

export interface WatchlistStore {
  list(profileId: string): Promise<WatchlistEntry[]>;
  add(profileId: string, ref: MediaRef): Promise<WatchlistEntry>;
  remove(profileId: string, ref: MediaRef): Promise<void>;
}

// Todas las consultas incluyen el usuario obtenido del JWT, incluso al borrar.
export function watchlistStore(db: PrismaClient): WatchlistStore {
  const select = { tmdbId: true, mediaType: true, createdAt: true } as const;
  const where = (profileId: string, ref: MediaRef) => ({
    profileId, tmdbId: ref.tmdb_id, mediaType: toPrismaMediaType(ref.media_type)
  });

  return {
    async list(profileId) {
      const [items, progress] = await db.$transaction([
        db.watchlistItem.findMany({ where: { profileId }, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        db.progress.findMany({ where: { profileId }, select: { tmdbId: true, mediaType: true, status: true } })
      ]);
      const statuses = new Map(progress.map(item => [`${item.mediaType}:${item.tmdbId}`, toApiProgressStatus(item.status)]));
      return items.map(item => ({
        tmdb_id: item.tmdbId, media_type: toApiMediaType(item.mediaType), created_at: item.createdAt.toISOString(),
        status: statuses.get(`${item.mediaType}:${item.tmdbId}`) ?? 'pending'
      }));
    },
    async add(profileId, ref) {
      const identity = where(profileId, ref);
      const [item, progress] = await db.$transaction(async tx => {
        // ON CONFLICT DO NOTHING evita duplicados también con solicitudes concurrentes.
        await tx.watchlistItem.createMany({ data: identity, skipDuplicates: true });
        return Promise.all([
          tx.watchlistItem.findUniqueOrThrow({ where: { profileId_tmdbId_mediaType: identity }, select }),
          tx.progress.findUnique({ where: { profileId_tmdbId_mediaType: identity }, select: { status: true } })
        ]);
      });
      return { ...ref, created_at: item.createdAt.toISOString(), status: progress ? toApiProgressStatus(progress.status) : 'pending' };
    },
    async remove(profileId, ref) {
      await db.watchlistItem.deleteMany({ where: where(profileId, ref) });
    }
  };
}
