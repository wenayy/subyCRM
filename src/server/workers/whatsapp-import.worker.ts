import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { whatsappService } from "../services/whatsapp.service";

const BATCH = 20;

export function startWhatsAppImportWorker() {
  const worker = new Worker(
    QUEUE_NAMES.WHATSAPP_IMPORT,
    async (job) => {
      const { userId, importJobId } = job.data as {
        userId: string;
        importJobId: string;
      };

      // Fetch contacts from the live in-memory cache at job-run time (same process as service)
      const contacts = whatsappService.getContactsForImport(userId);
      if (!contacts.length) {
        await prisma.importJob.update({
          where: { id: importJobId },
          data: { status: "failed", errorLog: { error: "No WhatsApp contacts in cache — WhatsApp may still be syncing. Wait a moment and try again." }, completedAt: new Date() },
        });
        return { imported: 0, updated: 0, skipped: 0 };
      }

      let imported = 0, updated = 0, skipped = 0;

      // Pre-fetch all existing WhatsApp platform records once
      const existing = await prisma.platform.findMany({
        where: { type: "whatsapp" },
        select: { platformId: true, contactId: true },
      });
      const existingSet = new Set(existing.map((p) => p.platformId));

      // Split into batches and process in parallel
      for (let i = 0; i < contacts.length; i += BATCH) {
        const batch = contacts.slice(i, i + BATCH);

        await Promise.allSettled(
          batch.map(async ({ jid, name, phoneDigits }) => {
            try {
              if (existingSet.has(phoneDigits) || existingSet.has(jid)) {
                updated++;
                return;
              }
              await prisma.contact.create({
                data: {
                  name,
                  userId,
                  type: "other",
                  domain: "other",
                  relationshipStrength: "cold",
                  platforms: {
                    create: [{ type: "whatsapp", platformId: phoneDigits, displayName: name }],
                  },
                },
              });
              existingSet.add(phoneDigits);
              imported++;
            } catch {
              skipped++;
            }
          })
        );

        // Update progress after each batch
        await prisma.importJob.update({
          where: { id: importJobId },
          data: { imported, deduplicated: updated, errors: skipped },
        }).catch(() => {});
      }

      await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          status: "completed",
          totalFound: imported + updated + skipped,
          imported,
          deduplicated: updated,
          errors: skipped,
          completedAt: new Date(),
        },
      });

      return { imported, updated, skipped };
    },
    { connection: redisConnection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[whatsapp-import] job ${job?.id} failed:`, err.message);
    if (job?.data?.importJobId) {
      prisma.importJob.update({
        where: { id: job.data.importJobId },
        data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
      }).catch(() => {});
    }
  });

  return worker;
}
