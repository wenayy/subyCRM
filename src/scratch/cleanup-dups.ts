import { prisma } from "../server/lib/prisma";

async function cleanup() {
  const blMessages = await (prisma as any).inboxMessage.findMany({
    where: { externalId: { startsWith: "bl-" }, fromMe: true },
    select: { id: true, externalId: true, contactId: true, platform: true, receivedAt: true, userId: true },
  });

  let deleted = 0;
  for (const blMsg of blMessages) {
    const ts = new Date(blMsg.receivedAt).getTime();
    const dups = await (prisma as any).inboxMessage.findMany({
      where: {
        userId: blMsg.userId,
        contactId: blMsg.contactId,
        platform: blMsg.platform,
        fromMe: true,
        receivedAt: { gte: new Date(ts - 10000), lte: new Date(ts + 10000) },
        NOT: { externalId: blMsg.externalId },
      },
      select: { id: true, externalId: true },
    });
    for (const dup of dups) {
      await (prisma as any).inboxMessage.delete({ where: { id: dup.id } }).catch(() => {});
      deleted++;
      console.log("Deleted:", dup.externalId, "→ kept:", blMsg.externalId);
    }
  }
  console.log("Done. Deleted", deleted, "duplicates.");
  await prisma.$disconnect();
}

cleanup().catch(console.error);
