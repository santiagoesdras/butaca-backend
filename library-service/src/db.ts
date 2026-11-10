import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL || "";
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

export * from "../generated/prisma/client.js";
export * from "./constants/moods.js";
