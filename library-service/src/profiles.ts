import type { PrismaClient } from '../generated/prisma/client.js';

export interface ProfileStore {
  /** Crea el perfil del usuario si no existe. Es idempotente y seguro con solicitudes concurrentes. */
  ensure(profileId: string): Promise<void>;
}

/**
 * El trigger de la migración crea el perfil de los usuarios nuevos, pero las cuentas registradas antes de
 * aplicarla no lo tienen y reciben 409 al guardar. Por eso el perfil también se asegura con el `sub`
 * verificado del JWT en la primera escritura. La llave foránea hacia auth.users impide perfiles inventados.
 * Los perfiles ya asegurados se recuerdan en memoria (con límite) para no repetir la consulta.
 */
export function profilesStore(db: Pick<PrismaClient, 'profile'>, maxRemembered = 10000): ProfileStore {
  const known = new Set<string>();
  return {
    async ensure(profileId) {
      if (known.has(profileId)) return;
      // ON CONFLICT DO NOTHING: no modifica un perfil existente (zona horaria, nombre, etc.).
      await db.profile.createMany({ data: { id: profileId }, skipDuplicates: true });
      if (known.size >= maxRemembered) known.delete(known.values().next().value!);
      known.add(profileId);
    }
  };
}
