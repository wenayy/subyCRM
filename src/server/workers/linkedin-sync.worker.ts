import { Worker, Job } from "bullmq";
import { redisConnection } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { linkedinService } from "../services/linkedin.service";

export interface LinkedInSyncJobData {
  userId?: string; // if omitted, syncs all users with a li_at cookie
}

export function startLinkedInSyncWorker() {
  const worker = new Worker<LinkedInSyncJobData>(
    QUEUE_NAMES.LINKEDIN_SYNC,
    async (job: Job<LinkedInSyncJobData>) => {
      const { userId } = job.data;

      const records = userId
        ? await (prisma as any).linkedInToken.findMany({ where: { userId, liAtCookie: { not: null } }, select: { userId: true } })
        : await (prisma as any).linkedInToken.findMany({ where: { liAtCookie: { not: null } }, select: { userId: true } });

      if (records.length === 0) {
        console.log("[linkedin-sync] No accounts with li_at cookie — skipping");
        return { synced: 0, users: 0 };
      }

      let totalSynced = 0;
      for (const { userId: uid } of records) {
        try {
          const { synced } = await linkedinService.syncMessages(uid);
          console.log(`[linkedin-sync] userId=${uid} synced ${synced} messages`);
          totalSynced += synced;
        } catch (err: any) {
          console.error(`[linkedin-sync] userId=${uid} failed:`, err.message);
        }
      }

      return { synced: totalSynced, users: records.length };
    },
    {
      connection: redisConnection.connection,
      concurrency: 1,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[linkedin-sync] job ${job.id} done — ${result.synced} messages across ${result.users} accounts`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[linkedin-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
