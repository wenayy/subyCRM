import { Worker, Job } from "bullmq";
import { redisConnection } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { slackService } from "../services/slack.service";

export interface SlackSyncJobData {
  userId?: string;
}

export function startSlackSyncWorker() {
  const worker = new Worker<SlackSyncJobData>(
    QUEUE_NAMES.SLACK_SYNC,
    async (job: Job<SlackSyncJobData>) => {
      const { userId } = job.data;

      const tokens = userId
        ? await (prisma as any).slackToken.findMany({ where: { userId }, select: { userId: true } })
        : await (prisma as any).slackToken.findMany({ select: { userId: true } });

      if (tokens.length === 0) {
        console.log("[slack-sync] No connected Slack accounts — skipping");
        return { synced: 0, users: 0 };
      }

      let totalSynced = 0;
      for (const { userId: uid } of tokens) {
        try {
          const { synced } = await slackService.sync(uid);
          console.log(`[slack-sync] userId=${uid} synced ${synced} messages`);
          totalSynced += synced;
        } catch (err: any) {
          console.error(`[slack-sync] userId=${uid} failed:`, err.message);
        }
      }

      return { synced: totalSynced, users: tokens.length };
    },
    {
      connection: redisConnection.connection,
      concurrency: 2,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("completed", (job, result) => {
    console.log(`[slack-sync] job ${job.id} done — ${result.synced} messages across ${result.users} accounts`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[slack-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
