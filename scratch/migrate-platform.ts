import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  await prisma.$executeRawUnsafe(`ALTER TABLE contacts.platforms DROP CONSTRAINT IF EXISTS platforms_type_platform_id_key`);
  console.log("dropped old constraint");
  await prisma.$executeRawUnsafe(`ALTER TABLE contacts.platforms ADD CONSTRAINT platforms_type_platform_id_contact_id_key UNIQUE (type, platform_id, contact_id)`);
  console.log("added new constraint");
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS platforms_type_platform_id_idx ON contacts.platforms (type, platform_id)`);
  console.log("added index");
}
main().then(() => { console.log("done"); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
