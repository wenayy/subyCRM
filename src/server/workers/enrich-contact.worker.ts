import { Worker, Job } from "bullmq";
import { redisConnection } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { enrichmentService } from "../services/enrichment.service";

export interface EnrichContactJobData {
  contactId: string;
}

export function startEnrichContactWorker() {
  const worker = new Worker<EnrichContactJobData>(
    QUEUE_NAMES.ENRICH_CONTACT,
    async (job: Job<EnrichContactJobData>) => {
      const { contactId } = job.data;

      console.log(`[enrich-contact] Enriching contact ${contactId}`);
      const result = await enrichmentService.enrichContact(contactId);
      console.log(`[enrich-contact] Done for ${contactId}`, result.enrichedData);
      return result;
    },
    {
      connection: redisConnection.connection,
      concurrency: 2,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[enrich-contact] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
