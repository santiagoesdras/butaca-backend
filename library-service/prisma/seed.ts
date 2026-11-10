import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { DEFAULT_MOODS } from "../src/constants/moods.js";

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL || "";
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

export async function seedMoods() {
  for (const mood of DEFAULT_MOODS) {
    await prisma.mood.upsert({
      where: { code: mood.code },
      update: { name: mood.name },
      create: {
        code: mood.code,
        name: mood.name,
      },
    });
  }
}

seedMoods()
  .then(async () => {
    console.log("Seed completado: 7 emociones aseguradas.");
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error("Error durante el seed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
