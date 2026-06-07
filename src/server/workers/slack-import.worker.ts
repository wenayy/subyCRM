import { Worker } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { slackService } from "../services/slack.service";

export function startSlackImportWorker() {
  return new Worker(
    QUEUE_NAMES.SLACK_IMPORT,
    async (job) => {
      const { userId, importJobId } = job.data as { userId: string; importJobId: string };
      try {
        const { imported, updated, skipped } = await slackService.importContacts(userId);
        await prisma.importJob.update({
          where: { id: importJobId },
          data: {
            status: "completed",
            totalFound: imported + updated + skipped,
            imported,
            deduplicated: updated,
            errors: skipped,
            completedAt: new Date(),
          },
        });
        console.log(`[slack-import] done — ${imported} new, ${updated} updated, ${skipped} skipped`);
        return { imported, updated, skipped };
      } catch (err: any) {
        await prisma.importJob.update({
          where: { id: importJobId },
          data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
        });
        throw err;
      }
    },
    { connection: redis, concurrency: 1 },
  );
}
