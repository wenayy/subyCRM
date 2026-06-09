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

      // Pull full messages by contactId (linked) + by senderId for any unlinked messages
      // that belong to this contact's platform IDs (handles phone format mismatches,
      // messages saved before the contact existed, etc.)
      const platformIds = contact.platforms.map((p: any) => p.platformId).filter(Boolean);

      const [linkedMessages, unlinkedMessages] = await Promise.all([
        (prisma as any).inboxMessage.findMany({
          where: { contactId },
          orderBy: { receivedAt: "desc" },
          take: 60,
          select: { id: true, platform: true, body: true, preview: true, fromMe: true, receivedAt: true },
        }),
        platformIds.length > 0
          ? (prisma as any).inboxMessage.findMany({
              where: {
                contactId: null,
                OR: platformIds.flatMap((pid: string) => [
                  { senderId: { contains: pid } },
                  { externalId: { contains: pid } },
                ]),
              },
              orderBy: { receivedAt: "desc" },
              take: 60,
              select: { id: true, platform: true, body: true, preview: true, fromMe: true, receivedAt: true },
            })
          : Promise.resolve([]),
      ]);

      // Deduplicate by id, merge and sort by receivedAt desc, take 60 most recent
      const seen = new Set<string>();
      const inboxMessages = [...linkedMessages, ...unlinkedMessages]
        .filter((m: any) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
        .sort((a: any, b: any) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
        .slice(0, 60);

      const summary = await aiService.generateSummary(contact, inboxMessages);

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
