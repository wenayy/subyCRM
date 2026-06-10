import { prisma } from "../server/lib/prisma";

async function main() {
  const linkedinContacts = await prisma.contact.findMany({
    where: {
      platforms: {
        some: {
          type: "linkedin",
        },
      },
    },
    select: {
      id: true,
      name: true,
      userId: true,
    },
  });

  console.log(`LinkedIn contacts total: ${linkedinContacts.length}`);
  for (const c of linkedinContacts) {
    console.log(`- Contact: "${c.name}" | Owner UserID: "${c.userId}" | ID: "${c.id}"`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
