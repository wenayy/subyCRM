import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { xService } from "../services/x.service";

export interface XDmSyncJobData {
  userId?: string; // if omitted, syncs all connected users
}

export function startXDmSyncWorker() {
  const worker = new Worker<XDmSyncJobData>(
    QUEUE_NAMES.X_DM_SYNC,
    async (job: Job<XDmSyncJobData>) => {
      const { userId } = job.data;

      const tokens = userId
        ? await (prisma as any).xToken.findMany({ where: { userId }, select: { userId: true } })
        : await (prisma as any).xToken.findMany({ select: { userId: true } });

      if (tokens.length === 0) {
        console.log("[x-dm-sync] No connected X accounts — skipping");
        return { synced: 0, users: 0 };
      }

      let totalSynced = 0;
      for (const { userId: uid } of tokens) {
        try {
          const { synced } = await xService.sync(uid);
          console.log(`[x-dm-sync] userId=${uid} synced ${synced} DMs`);
          totalSynced += synced;
        } catch (err: any) {
          // Log but don't rethrow — one user's failure shouldn't block others
          console.error(`[x-dm-sync] userId=${uid} failed:`, err.message);
        }
      }

      return { synced: totalSynced, users: tokens.length };
    },
    {
      connection: redis,
      concurrency: 2,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[x-dm-sync] job ${job.id} done — ${result.synced} DMs across ${result.users} accounts`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[x-dm-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
