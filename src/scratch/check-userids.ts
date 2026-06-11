import { prisma } from "../server/lib/prisma";
async function main() {
  const users = await (prisma as any).user.findMany({ select: { id: true, email: true } });
  const msgs = await (prisma as any).inboxMessage.groupBy({ by: ["userId"], _count: true });
  console.log("Users:", JSON.stringify(users));
  console.log("Messages by userId:", JSON.stringify(msgs));
}
main().catch(console.error).finally(() => prisma.$disconnect());
