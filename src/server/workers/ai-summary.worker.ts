import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { aiService } from "../services/ai.service";
import { prisma } from "../lib/prisma";
import { cache, CACHE_KEYS } from "../lib/cache";

export interface AiSummaryJobData {
  contactId: string;
}

// 15 minutes TTL for summary cache
const SUMMARY_TTL = 15 * 60;

export function startAiSummaryWorker() {
  const worker = new Worker<AiSummaryJobData>(
    QUEUE_NAMES.AI_SUMMARY,
    async (job: Job<AiSummaryJobData>) => {
      const { contactId } = job.data;

      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        include: {
          platforms: true,
          interactions: { orderBy: { occurredAt: "desc" }, take: 20 },
          notes: { orderBy: { createdAt: "desc" }, take: 10 },
          contactTags: { include: { tag: true } },
        },
      });

      if (!contact) {
        console.warn(`[ai-summary] Contact ${contactId} not found — skipping`);
        return null;
      }

      const summary = await aiService.generateSummary(contact);

      // Persist to DB
      await prisma.contact.update({
        where: { id: contactId },
        data: { aiSummary: summary },
      });

      // Cache for 15 minutes
      await cache.set(CACHE_KEYS.contactSummary(contactId), { summary }, SUMMARY_TTL);

      console.log(`[ai-summary] Generated summary for ${contact.name}`);
      return { summary };
    },
    {
      connection: redis,
      concurrency: 3,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[ai-summary] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
