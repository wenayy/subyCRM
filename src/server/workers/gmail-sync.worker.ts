import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { syncThreads } from "../services/gmail.service";

export interface GmailSyncJobData {
  userId?: string; // if omitted, syncs all connected users
}

export function startGmailSyncWorker() {
  const worker = new Worker<GmailSyncJobData>(
    QUEUE_NAMES.GMAIL_SYNC,
    async (job: Job<GmailSyncJobData>) => {
      const { userId } = job.data;

      // Collect which users to sync
      const tokens = userId
        ? await (prisma as any).gmailToken.findMany({ where: { userId }, select: { userId: true } })
        : await (prisma as any).gmailToken.findMany({ select: { userId: true } });

      if (tokens.length === 0) {
        console.log("[gmail-sync] No connected Gmail accounts — skipping");
        return { synced: 0, users: 0 };
      }

      let totalSynced = 0;
      for (const { userId: uid } of tokens) {
        try {
          const count = await syncThreads(uid);
          console.log(`[gmail-sync] userId=${uid} synced ${count} threads`);
          totalSynced += count;
        } catch (err: any) {
          console.error(`[gmail-sync] userId=${uid} failed:`, err.message);
        }
      }

      return { synced: totalSynced, users: tokens.length };
    },
    {
      connection: redis.connection,
      concurrency: 2,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[gmail-sync] job ${job.id} done — ${result.synced} threads across ${result.users} accounts`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[gmail-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
