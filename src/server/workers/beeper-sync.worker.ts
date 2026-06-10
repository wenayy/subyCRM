import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { beeperService } from "../services/beeper.service";

export interface BeeperSyncJobData {
  userId?: string;
}

export function startBeeperSyncWorker() {
  const worker = new Worker<BeeperSyncJobData>(
    QUEUE_NAMES.BEEPER_SYNC,
    async (job: Job<BeeperSyncJobData>) => {
      const { userId } = job.data;

      // Query connected Beeper accounts
      const sessions = userId
        ? await (prisma as any).beeperSession.findMany({ where: { userId, connected: true }, select: { userId: true } })
        : await (prisma as any).beeperSession.findMany({ where: { connected: true }, select: { userId: true } });

      if (sessions.length === 0) {
        console.log("[beeper-sync] No connected Beeper accounts — skipping");
        return { synced: 0, accounts: 0 };
      }

      let totalSynced = 0;
      for (const { userId: uid } of sessions) {
        try {
          const { synced } = await beeperService.sync(uid);
          console.log(`[beeper-sync] userId=${uid} synced ${synced} messages/events`);
          totalSynced += synced;
        } catch (err: any) {
          console.error(`[beeper-sync] userId=${uid} failed:`, err.message);
        }
      }

      return { synced: totalSynced, accounts: sessions.length };
    },
    {
      connection: redis,
      concurrency: 2,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[beeper-sync] job ${job.id} done — ${result.synced} messages/events across ${result.accounts} accounts`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[beeper-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
