import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";

const BATCH = 20;

export function startTelegramImportWorker() {
  const worker = new Worker(
    QUEUE_NAMES.TELEGRAM_IMPORT,
    async (job) => {
      const { userId, importJobId } = job.data as { userId: string; importJobId: string };

      const rec = await (prisma as any).telegramPersonalSession.findUnique({ where: { userId } });
      if (!rec?.sessionStr) throw new Error("Telegram not connected");

      const { TelegramClient, StringSession } = await (async () => {
        const { TelegramClient } = await import("telegram");
        const { StringSession } = await import("telegram/sessions");
        return { TelegramClient, StringSession };
      })();

      const client = new TelegramClient(
        new StringSession(rec.sessionStr),
        rec.apiId,
        rec.apiHash,
        { connectionRetries: 3 }
      );
      await client.connect();

      const dialogs = await client.getDialogs({ limit: 500 });

      // Pre-fetch all existing telegram + whatsapp platform records once
      const existing = await prisma.platform.findMany({
        where: { type: { in: ["telegram", "whatsapp"] } },
        select: { platformId: true, contactId: true, contact: { select: { id: true, name: true, lastContactDate: true } } },
      });
      const byPlatformId = new Map(existing.map((p) => [p.platformId.toLowerCase(), p]));

      let imported = 0, updated = 0, skipped = 0;

      // Collect valid user entities
      const entities: Array<{
        idStr: string; username: string | null; phone: string | null;
        fullName: string; lastContactDate: Date | null;
      }> = [];

      for (const dialog of dialogs) {
        const entity = dialog.entity as any;
        if (!entity || entity.className !== "User" || entity.bot || entity.self) continue;
        const fullName = [entity.firstName ?? "", entity.lastName ?? ""].filter(Boolean).join(" ").trim();
        if (!fullName) continue;
        const idStr = entity.id?.toString();
        if (!idStr) continue;
        entities.push({
          idStr,
          username: entity.username ?? null,
          phone: entity.phone ?? null,
          fullName,
          lastContactDate: dialog.date ? new Date(dialog.date * 1000) : null,
        });
      }

      // Process in parallel batches
      for (let i = 0; i < entities.length; i += BATCH) {
        const batch = entities.slice(i, i + BATCH);

        await Promise.allSettled(
          batch.map(async ({ idStr, username, phone, fullName, lastContactDate }) => {
            try {
              const platformId = username ?? idStr;
              const lookupKeys = [idStr, username, phone].filter(Boolean) as string[];

              // Check existing via pre-fetched map
              let existingPlatform = lookupKeys
                .map((k) => byPlatformId.get(k.toLowerCase()))
                .find(Boolean);

              if (existingPlatform?.contact) {
                // Update lastContactDate if newer
                if (lastContactDate && (!existingPlatform.contact.lastContactDate || lastContactDate > existingPlatform.contact.lastContactDate)) {
                  await prisma.contact.update({
                    where: { id: existingPlatform.contact.id },
                    data: { lastContactDate },
                  });
                }
                updated++;
                return;
              }

              // Create new contact
              const created = await prisma.contact.create({
                data: {
                  name: fullName,
                  userId,
                  lastContactDate,
                  firstContactDate: lastContactDate,
                  type: "other",
                  domain: "other",
                  relationshipStrength: "cold",
                  platforms: {
                    create: [{
                      type: "telegram" as const,
                      platformId,
                      displayName: fullName,
                      profileUrl: username ? `https://t.me/${username}` : null,
                    }],
                  },
                },
              });

              // Add to in-memory map so subsequent batches see it
              byPlatformId.set(platformId.toLowerCase(), {
                platformId,
                contactId: created.id,
                contact: { id: created.id, name: created.name, lastContactDate },
              });

              // Cross-link WhatsApp if phone known
              if (phone) {
                const phoneDigits = phone.replace(/\D/g, "");
                const existingWa = await prisma.platform.findFirst({ where: { type: "whatsapp", platformId: phoneDigits } });
                if (!existingWa) {
                  await prisma.platform.create({
                    data: { contactId: created.id, type: "whatsapp", platformId: phoneDigits, displayName: fullName },
                  }).catch(() => {});
                }
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

      await client.disconnect();

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
    console.error(`[telegram-import] job ${job?.id} failed:`, err.message);
    if (job?.data?.importJobId) {
      prisma.importJob.update({
        where: { id: job.data.importJobId },
        data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
      }).catch(() => {});
    }
  });

  return worker;
}
