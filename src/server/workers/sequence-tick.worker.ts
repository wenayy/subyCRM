import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from "../lib/queues";
import { prisma } from "../lib/prisma";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SequenceTickJobData {}

export function startSequenceTickWorker() {
  const worker = new Worker<SequenceTickJobData>(
    QUEUE_NAMES.SEQUENCE_TICK,
    async (_job: Job<SequenceTickJobData>) => {
      const now = new Date();

      // Find all active enrollments with a due step
      const dueEnrollments = await (prisma as any).sequenceEnrollment.findMany({
        where: {
          status: "active",
          nextStepDue: { lte: now },
        },
        include: {
          sequence: {
            include: { steps: { orderBy: { stepNumber: "asc" } } },
          },
        },
      });

      console.log(`[sequence-tick] Found ${dueEnrollments.length} due enrollment(s)`);

      let advanced = 0;
      let completed = 0;

      for (const enrollment of dueEnrollments) {
        try {
          const steps = enrollment.sequence.steps as Array<{
            stepNumber: number;
            delayDays: number;
          }>;

          const nextStepNumber = enrollment.currentStep + 1;
          const nextStep = steps.find((s) => s.stepNumber === nextStepNumber);

          if (!nextStep) {
            // No more steps — mark as completed
            await (prisma as any).sequenceEnrollment.update({
              where: { id: enrollment.id },
              data: {
                status: "completed",
                completedAt: now,
                nextStepDue: null,
              },
            });
            completed++;
          } else {
            // Advance to next step and compute next due date
            const nextDue = new Date(now.getTime() + nextStep.delayDays * 86400_000);
            await (prisma as any).sequenceEnrollment.update({
              where: { id: enrollment.id },
              data: {
                currentStep: nextStepNumber,
                nextStepDue: nextDue,
              },
            });
            advanced++;
          }
        } catch (err) {
          console.error(`[sequence-tick] Failed to advance enrollment ${enrollment.id}:`, err);
        }
      }

      console.log(`[sequence-tick] Advanced: ${advanced}, Completed: ${completed}`);
      return { advanced, completed };
    },
    {
      connection: redis,
      concurrency: 1,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[sequence-tick] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
