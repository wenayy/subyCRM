import { prisma } from "../server/lib/prisma";
import { beeperService } from "../server/services/beeper.service";

async function main() {
  const userId = "VtLh7xXUxheafzmAkdEP9ZytIvSAjO07";
  console.log(`Running sync diagnostics for user: ${userId}`);

  // Reset nextBatch to force a full scan of all joined rooms and verify ownership fix
  await (prisma as any).beeperSession.update({
    where: { userId },
    data: { nextBatch: null },
  }).catch(() => {});

  try {
    const result = await beeperService.sync(userId);
    console.log("\nSync results:", JSON.stringify(result, null, 2));

    const contacts = await prisma.contact.findMany({
      where: { userId },
      include: { platforms: true },
    });

    console.log(`\nTotal contacts owned by ${userId} now: ${contacts.length}`);
    const byPlatform: Record<string, number> = {};
    for (const c of contacts) {
      for (const p of c.platforms) {
        byPlatform[p.type] = (byPlatform[p.type] ?? 0) + 1;
      }
    }
    console.log("Contacts count by platform owned by user:", byPlatform);

  } catch (err: any) {
    console.error("Sync error:", err.message || err);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
