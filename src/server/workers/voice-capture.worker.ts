import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { processVoiceCapture } from "../services/telegram-bot.service";

export interface VoiceCaptureJobData {
  transcript: string;
  userId?: string;
}

export function startVoiceCaptureWorker() {
  const worker = new Worker<VoiceCaptureJobData>(
    QUEUE_NAMES.VOICE_CAPTURE,
    async (job: Job<VoiceCaptureJobData>) => {
      const { transcript } = job.data;

      console.log(`[voice-capture] Processing transcript: "${transcript.slice(0, 80)}..."`);
      const result = await processVoiceCapture(transcript);
      console.log(`[voice-capture] Done — action=${result.action} status=${result.status}`);
      return result;
    },
    {
      connection: redis,
      concurrency: 2,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[voice-capture] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
