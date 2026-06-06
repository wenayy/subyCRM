import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { aiService, sanitizeType, sanitizeDomain } from "../services/ai.service";
import { prisma } from "../lib/prisma";
import { cache, CACHE_KEYS } from "../lib/cache";

export interface AiClassifyJobData {
  contactId: string;
}

export function startAiClassifyWorker() {
  const worker = new Worker<AiClassifyJobData>(
    QUEUE_NAMES.AI_CLASSIFY,
    async (job: Job<AiClassifyJobData>) => {
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
        console.warn(`[ai-classify] Contact ${contactId} not found — skipping`);
        return null;
      }

      const result = await aiService.classifyContact(contact);

      const type = sanitizeType(result.type);
      const domain = sanitizeDomain(result.domain);

      await prisma.contact.update({
        where: { id: contactId },
        data: {
          type: type as any,
          domain: domain as any,
        },
      });

      // Invalidate summary cache since classification changed
      await cache.del(CACHE_KEYS.contactSummary(contactId));
      await cache.invalidateContacts().catch(console.error);

      console.log(`[ai-classify] ${contact.name} → type=${type} domain=${domain}`);
      return { type, domain, confidence: result.confidence };
    },
    {
      connection: redis.connection,
      concurrency: 5,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[ai-classify] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
