import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { aiService } from "../services/ai.service";
import { prisma } from "../lib/prisma";
import { cache, CACHE_KEYS } from "../lib/cache";

export interface AiPrepJobData {
  contactId: string;
  eventId?: string;
}

// 1 hour TTL for briefing cache
const BRIEFING_TTL = 60 * 60;

export function startAiPrepWorker() {
  const worker = new Worker<AiPrepJobData>(
    QUEUE_NAMES.AI_PREP,
    async (job: Job<AiPrepJobData>) => {
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
        console.warn(`[ai-prep] Contact ${contactId} not found — skipping`);
        return null;
      }

      const prep = await aiService.generatePrep(contact);

      // Cache briefing for 1 hour
      await cache.set(CACHE_KEYS.contactBriefing(contactId), prep, BRIEFING_TTL);

      console.log(`[ai-prep] Generated prep briefing for ${contact.name}`);
      return prep;
    },
    {
      connection: redis,
      concurrency: 3,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[ai-prep] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
