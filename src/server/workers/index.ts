import type { Worker } from "bullmq";
import { startAiClassifyWorker } from "./ai-classify.worker";
import { startAiSummaryWorker } from "./ai-summary.worker";
import { startAiPrepWorker } from "./ai-prep.worker";
import { startVoiceCaptureWorker } from "./voice-capture.worker";
import { startEnrichContactWorker } from "./enrich-contact.worker";
import { startSequenceTickWorker } from "./sequence-tick.worker";
import { startDailyBriefWorker } from "./daily-brief.worker";
import { startOutcomePromptWorker } from "./outcome-prompt.worker";
import { startGmailSyncWorker } from "./gmail-sync.worker";
import { startXDmSyncWorker } from "./x-dm-sync.worker";
import { startSlackSyncWorker } from "./slack-sync.worker";
import { startDiscordSyncWorker } from "./discord-sync.worker";
import { startCsvImportWorker } from "./csv-import.worker";
import { startLinkedInSyncWorker } from "./linkedin-sync.worker";
import { startWhatsAppImportWorker } from "./whatsapp-import.worker";
import { startTelegramImportWorker } from "./telegram-import.worker";
import { startWhatsAppSendWorker } from "./whatsapp-send.worker";

let workers: Worker[] = [];

export function startAllWorkers() {
  console.log("[workers] Starting all BullMQ workers...");

  workers = [
    startAiClassifyWorker(),
    startAiSummaryWorker(),
    startAiPrepWorker(),
    startVoiceCaptureWorker(),
    startEnrichContactWorker(),
    startSequenceTickWorker(),
    startDailyBriefWorker(),
    startOutcomePromptWorker(),
    startGmailSyncWorker(),
    startXDmSyncWorker(),
    startSlackSyncWorker(),
    startDiscordSyncWorker(),
    startCsvImportWorker(),
    startLinkedInSyncWorker(),
    startWhatsAppImportWorker(),
    startTelegramImportWorker(),
    startWhatsAppSendWorker(),
  ];

  console.log(`[workers] ${workers.length} workers running`);
  return workers;
}

export async function shutdownWorkers() {
  console.log("[workers] Shutting down BullMQ workers...");
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
  console.log("[workers] All workers shut down");
}
