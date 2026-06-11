import { prisma } from "../server/lib/prisma";
async function main() {
  const USER = "zsKAG09x9TofyA0f1PglZp9kibhXhl04";
  const m = await (prisma as any).inboxMessage.deleteMany({ where: { userId: USER } });
  console.log(`Deleted ${m.count} messages`);
  const c = await (prisma as any).contact.deleteMany({ where: { userId: USER } });
  console.log(`Deleted ${c.count} contacts`);
  const sess = await (prisma as any).beeperSession.deleteMany({ where: { userId: USER } });
  console.log(`Deleted ${sess.count} beeper sessions`);
  console.log("Clean slate ready");
}
main().catch(console.error).finally(() => prisma.$disconnect());
