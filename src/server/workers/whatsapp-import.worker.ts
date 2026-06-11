import { Worker } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { whatsappService, invalidatePlatformCache } from "../services/whatsapp.service";
import { inboxService } from "../services/inbox.service";

const BATCH = 20;

// Build import contacts list from the in-memory WhatsApp contacts cache.
// Falls back to extracting senders from existing inbox messages if cache is empty
// (happens after server restart when contacts.upsert hasn't re-fired yet).
async function resolveContacts(userId: string): Promise<Array<{ jid: string; name: string; phoneDigits: string }>> {
  // Primary: in-memory cache populated by contacts.upsert event
  let contacts = whatsappService.getContactsForImport(userId);
  if (contacts.length) return contacts;

  // Wait up to 60s for WhatsApp to finish reconnecting and fire contacts.upsert
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    contacts = whatsappService.getContactsForImport(userId);
    if (contacts.length) return contacts;
  }

  // Fallback: extract unique senders from WhatsApp inbox messages.
  // This covers the server-restart case where contacts.upsert never re-fires.
  console.log("[whatsapp-import] Cache empty after 60s — falling back to inbox message senders");
  const messages = await (prisma as any).inboxMessage.findMany({
    where: { userId, platform: "whatsapp", senderId: { not: null } },
    select: { senderId: true, contactName: true },
    distinct: ["senderId"],
  });

  return messages
    .filter((m: any) => m.senderId && m.senderId.endsWith("@s.whatsapp.net"))
    .map((m: any) => {
      const phoneDigits = m.senderId.split("@")[0].replace(/\D/g, "");
      return {
        jid: m.senderId,
        name: m.contactName || phoneDigits,
        phoneDigits,
      };
    })
    .filter((c: any) => c.phoneDigits.length >= 5);
}

export function startWhatsAppImportWorker() {
  const worker = new Worker(
    QUEUE_NAMES.WHATSAPP_IMPORT,
    async (job) => {
      const { userId, importJobId } = job.data as {
        userId: string;
        importJobId: string;
      };

      const contacts = await resolveContacts(userId);

      if (!contacts.length) {
        await prisma.importJob.update({
          where: { id: importJobId },
          data: {
            status: "failed",
            errorLog: { error: "No WhatsApp contacts found — make sure WhatsApp is connected and has messages." },
            completedAt: new Date(),
          },
        });
        return { imported: 0, updated: 0, skipped: 0 };
      }

      let imported = 0, updated = 0, skipped = 0;

      // Pre-fetch only this user's existing WhatsApp platform records (id → contactId)
      const existingPlatforms = await prisma.platform.findMany({
        where: { type: "whatsapp", contact: { userId } },
        include: { contact: { select: { name: true } } },
      });
      const existingMap = new Map(existingPlatforms.map((p) => [
        p.platformId,
        { contactId: p.contactId, currentName: (p as any).contact?.name ?? "" },
      ]));

      for (let i = 0; i < contacts.length; i += BATCH) {
        const batch = contacts.slice(i, i + BATCH);

        await Promise.allSettled(
          batch.map(async ({ jid, name, phoneDigits }) => {
            try {
              const hit = existingMap.get(phoneDigits) ?? existingMap.get(jid);
              if (hit) {
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

        await prisma.importJob.update({
          where: { id: importJobId },
          data: { imported, deduplicated: updated, errors: skipped },
        }).catch(() => {});
      }

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

      if (imported > 0 || updated > 0) {
        const { cache } = await import("../lib/cache");
        cache.invalidateContacts().catch(() => {});
      }
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
