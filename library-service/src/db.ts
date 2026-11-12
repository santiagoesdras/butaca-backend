import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { loadConfig, optionalText } from "../../shared/config.js";

// DATABASE_URL es la conexión de la aplicación; DIRECT_URL se acepta como respaldo (scripts y seed).
// Aquí no se exige: este módulo también se importa por sus enums. El arranque del servicio (server.ts)
// valida DATABASE_URL como obligatoria antes de conectarse.
const env = loadConfig({ DATABASE_URL: optionalText, DIRECT_URL: optionalText });
const connectionString = env.DATABASE_URL ?? env.DIRECT_URL ?? "";
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

export * from "../generated/prisma/client.js";
export * from "./constants/moods.js";
