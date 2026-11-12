import "dotenv/config";
import { defineConfig } from "prisma/config";
import { z } from "zod";

// La CLI de Prisma usa DIRECT_URL (conexión directa, sin pooler) para migraciones y generate.
const env = z.object({
  DIRECT_URL: z.string({ error: "DIRECT_URL es obligatoria" }).regex(/^postgres(ql)?:\/\/\S+$/, "DIRECT_URL debe ser una URL postgresql://"),
}).safeParse(process.env);
if (!env.success) throw new Error("Configuración inválida de Prisma: " + env.error.issues[0]?.message);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node --loader ts-node/esm prisma/seed.ts",
  },
  datasource: {
    url: env.data.DIRECT_URL,
  },
});
