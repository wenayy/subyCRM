import { Worker } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";
import { broadcastInboxEvent } from "../services/sse.service";

export interface WhatsAppSendJob {
  userId: string;
  jid: string;
  text: string;
  tempId: string;
  contactId: string | null;
}

export function startWhatsAppSendWorker() {
  const worker = new Worker<WhatsAppSendJob>(
    QUEUE_NAMES.WHATSAPP_SEND,
    async (job) => {
      const { userId, jid, text, tempId } = job.data;
      const { parseMediaMarkdown } = await import("../services/inbox.service");
      const { whatsappService, sendMessageQueued } = await import("../services/whatsapp.service");

      const media = parseMediaMarkdown(text);
      let keyId: string | undefined;

      if (media) {
        const { ensureMediaLocal } = await import("../lib/media-store");
        await ensureMediaLocal(media.filePath);
        // Retry as media send — same path as the original attempt
        const result = await whatsappService.sendMediaMessage(jid, media.filePath, media.caption, userId);
        keyId = (result as any)?.key?.id;
      } else {
        const result = await sendMessageQueued(userId, jid, text);
        keyId = result.keyId;
      }

      if (keyId) {
        await (prisma as any).inboxMessage.updateMany({
          where: { platform: "whatsapp", externalId: tempId },
          data: { externalId: keyId },
        });
      }
    },
    { connection: redis, concurrency: 3 }
  );

  worker.on("failed", (job, _err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 10;
    if (job.attemptsMade >= maxAttempts) {
      broadcastInboxEvent("send_failed", {
        platform: "whatsapp",
        tempId: job.data.tempId,
        contactId: job.data.contactId,
      });
    }
  });

  return worker;
}
