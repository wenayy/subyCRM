import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { discordService } from "../services/discord.service";

export interface DiscordSyncJobData {
  userId?: string;
}

export function startDiscordSyncWorker() {
  const worker = new Worker<DiscordSyncJobData>(
    QUEUE_NAMES.DISCORD_SYNC,
    async (job: Job<DiscordSyncJobData>) => {
      const { userId } = job.data;

      const tokens = userId
        ? await (prisma as any).discordToken.findMany({ where: { userId }, select: { userId: true } })
        : await (prisma as any).discordToken.findMany({ select: { userId: true } });

      if (tokens.length === 0) {
        console.log("[discord-sync] No connected Discord accounts — skipping");
        return { synced: 0, users: 0 };
      }

      let totalSynced = 0;
      for (const { userId: uid } of tokens) {
        try {
          const { synced } = await discordService.sync(uid);
          console.log(`[discord-sync] userId=${uid} synced ${synced} messages`);
          totalSynced += synced;
        } catch (err: any) {
          console.error(`[discord-sync] userId=${uid} failed:`, err.message);
        }
      }

      return { synced: totalSynced, users: tokens.length };
    },
    {
      connection: redis,
      concurrency: 1,
      lockDuration: 300_000,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[discord-sync] job ${job.id} done — ${result.synced} messages across ${result.users} accounts`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[discord-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
