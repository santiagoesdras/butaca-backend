import type { PrismaClient } from '../generated/prisma/client.js';
import { toApiMediaType, toPrismaMediaType, type FavoriteDto } from './dtos/media.dto.js';
import type { MediaRef } from './watchlist.js';

export type FavoriteEntry = FavoriteDto;

export interface FavoriteStore {
  list(profileId: string): Promise<FavoriteEntry[]>;
  add(profileId: string, ref: MediaRef): Promise<FavoriteEntry>;
  remove(profileId: string, ref: MediaRef): Promise<void>;
}

// Igual que watchlist: todas las consultas incluyen el usuario obtenido del JWT, incluso al borrar.
export function favoritesStore(db: Pick<PrismaClient, 'favorite' | '$transaction'>): FavoriteStore {
  const select = { tmdbId: true, mediaType: true, createdAt: true } as const;
  const where = (profileId: string, ref: MediaRef) => ({
    profileId, tmdbId: ref.tmdb_id, mediaType: toPrismaMediaType(ref.media_type)
  });

  return {
    async list(profileId) {
      const items = await db.favorite.findMany({ where: { profileId }, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      return items.map(item => ({
        tmdb_id: item.tmdbId, media_type: toApiMediaType(item.mediaType), created_at: item.createdAt.toISOString()
      }));
    },
    async add(profileId, ref) {
      const identity = where(profileId, ref);
      const item = await db.$transaction(async tx => {
        // ON CONFLICT DO NOTHING evita duplicados también con solicitudes concurrentes.
        await tx.favorite.createMany({ data: identity, skipDuplicates: true });
        return tx.favorite.findUniqueOrThrow({ where: { profileId_tmdbId_mediaType: identity }, select });
      });
      return { ...ref, created_at: item.createdAt.toISOString() };
    },
    async remove(profileId, ref) {
      await db.favorite.deleteMany({ where: where(profileId, ref) });
    }
  };
}
