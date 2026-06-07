import { Worker } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { whatsappService, invalidatePlatformCache } from "../services/whatsapp.service";
import { inboxService } from "../services/inbox.service";

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

      // Pre-fetch only this user's existing WhatsApp platform records (id → contactId)
      const existingPlatforms = await prisma.platform.findMany({
        where: { type: "whatsapp", contact: { userId } },
        include: { contact: { select: { name: true } } },
      });
      // Map: phoneDigits/jid → { contactId, currentName }
      const existingMap = new Map(existingPlatforms.map((p) => [
        p.platformId,
        { contactId: p.contactId, currentName: (p as any).contact?.name ?? "" },
      ]));

      // Split into batches and process in parallel
      for (let i = 0; i < contacts.length; i += BATCH) {
        const batch = contacts.slice(i, i + BATCH);

        await Promise.allSettled(
          batch.map(async ({ jid, name, phoneDigits }) => {
            try {
              const hit = existingMap.get(phoneDigits) ?? existingMap.get(jid);
              if (hit) {
                // If the incoming name is a real phone-book name (info.name, not notify/pushName),
                // update the CRM contact name to stay in sync with the user's phone contacts.
                // We detect "better" names by checking if it lacks the telltale notify-format markers.
                const looksLikePushName = (n: string) => /_\d{4,}/.test(n) || (n.includes("_") && /\d/.test(n) && n.split("_").length > 2);
              const isBetterName = name && name !== hit.currentName && !name.match(/^[+\d]/) && name.length > 1
                && !(looksLikePushName(name) && !looksLikePushName(hit.currentName));
              if (isBetterName) {
                  await prisma.contact.update({
                    where: { id: hit.contactId },
                    data: { name },
                  }).catch(() => {});
                }
                updated++;
                return;
              }

              // Before creating, check if this user already has a contact with this phone
              // (manually-added contacts without a WA platform yet). Scope to userId so we
              // don't skip creation for User B just because User A has the same phone.
              const contactByPhone = await prisma.platform.findFirst({
                where: { type: "whatsapp", platformId: phoneDigits, contact: { userId } },
                select: { contactId: true },
              });
              if (contactByPhone) {
                existingMap.set(phoneDigits, { contactId: contactByPhone.contactId, currentName: name });
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
              existingMap.set(phoneDigits, { contactId: "", currentName: name });

              // Retroactively link any inbox messages saved before this contact existed
              const newContact = await prisma.platform.findFirst({
                where: { type: "whatsapp", platformId: phoneDigits },
                select: { contactId: true },
              });
              if (newContact) {
                await inboxService.linkMessagesToContact(newContact.contactId, "whatsapp", phoneDigits).catch(() => {});
                await inboxService.linkMessagesToContact(newContact.contactId, "whatsapp", jid).catch(() => {});
              }

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

      // Flush the platform cache so new contacts are matched immediately on next message
      invalidatePlatformCache(userId);

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
    { connection: redis, concurrency: 1, lockDuration: 300_000 }
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
