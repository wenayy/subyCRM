import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis";
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
      const { sendMessageQueued } = await import("../services/whatsapp.service");
      const { keyId } = await sendMessageQueued(userId, jid, text);
      if (keyId) {
        await (prisma as any).inboxMessage.updateMany({
          where: { platform: "whatsapp", externalId: tempId },
          data: { externalId: keyId },
        });
      }
    },
    { connection: redisConnection, concurrency: 3 }
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
