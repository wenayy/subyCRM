import { config } from "dotenv";
config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const TAGS = ["Investor", "Strategic", "EU", "US", "Crypto"];

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) { console.error("No user found — sign up first"); process.exit(1); }

  for (const name of TAGS) {
    await (prisma as any).tag.upsert({
      where: { userId_name: { userId: user.id, name } },
      create: { userId: user.id, name },
      update: {},
    });
    console.log(`✓ ${name}`);
  }
  console.log("Done.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
