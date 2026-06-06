import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { QUEUE_NAMES } from "../lib/queues";
import { prisma } from "../lib/prisma";

export interface CsvImportJobData {
  jobId: string;
  userId: string;
  rows: Array<{
    name: string;
    email: string;
    company: string;
    role: string;
    linkedin: string;
    twitter: string;
    notes: string;
    tags: string;
  }>;
  totalFound: number;
}

export function startCsvImportWorker() {
  const worker = new Worker<CsvImportJobData>(
    QUEUE_NAMES.CSV_IMPORT,
    async (job: Job<CsvImportJobData>) => {
      const { jobId, userId, rows, totalFound } = job.data;

      let imported = 0, skipped = 0, errors = 0;

      try {
        const names = rows.map((r) => r.name);

        // Only check duplicates for names actually in this CSV
        const existing = await prisma.contact.findMany({
          where: { userId, name: { in: names } },
          select: { name: true },
        });
        const existingNames = new Set(existing.map((c) => c.name.toLowerCase().trim()));

        const toCreate = rows.filter((r) => {
          if (existingNames.has(r.name.toLowerCase().trim())) { skipped++; return false; }
          return true;
        });

        if (toCreate.length === 0) {
          await prisma.importJob.update({
            where: { id: jobId },
            data: { status: "completed", totalFound, imported: 0, deduplicated: skipped, errors: 0, completedAt: new Date() },
          });
          return;
        }

        // Batch create all contacts
        await prisma.contact.createMany({
          data: toCreate.map((r) => ({
            userId,
            name: r.name,
            company: r.company || null,
            role: r.role || null,
            type: "other" as const,
            domain: "other" as const,
            relationshipStrength: "cold" as const,
          })),
          skipDuplicates: true,
        });

        // Fetch back IDs
        const created = await prisma.contact.findMany({
          where: { userId, name: { in: toCreate.map((r) => r.name) } },
          select: { id: true, name: true },
        });
        const idByName = new Map(created.map((c) => [c.name.toLowerCase().trim(), c.id]));

        const platformData: any[] = [];
        const noteData: any[] = [];
        const tagWork: Array<{ contactId: string; tagNames: string[] }> = [];

        for (const r of toCreate) {
          const contactId = idByName.get(r.name.toLowerCase().trim());
          if (!contactId) { errors++; continue; }

          if (r.email) platformData.push({ contactId, type: "email", platformId: r.email, displayName: r.name });
          if (r.linkedin) {
            const slug = r.linkedin.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? r.linkedin;
            platformData.push({ contactId, type: "linkedin", platformId: slug, profileUrl: r.linkedin.startsWith("http") ? r.linkedin : `https://www.linkedin.com/in/${slug}`, displayName: r.name });
          }
          if (r.twitter) {
            const handle = r.twitter.replace(/^@/, "").replace(/.*(?:twitter|x)\.com\//, "");
            platformData.push({ contactId, type: "x", platformId: handle, profileUrl: `https://x.com/${handle}`, displayName: handle });
          }
          if (r.notes) noteData.push({ contactId, content: r.notes });
          if (r.tags) tagWork.push({ contactId, tagNames: r.tags.split(";").map((t) => t.trim()).filter(Boolean) });

          imported++;
        }

        await Promise.all([
          platformData.length > 0 ? prisma.platform.createMany({ data: platformData, skipDuplicates: true }).catch(() => {}) : Promise.resolve(),
          noteData.length > 0 ? prisma.note.createMany({ data: noteData }).catch(() => {}) : Promise.resolve(),
        ]);

        await Promise.all(tagWork.map(async ({ contactId, tagNames }) => {
          for (const tagName of tagNames) {
            try {
              const tag = await prisma.tag.upsert({
                where: { userId_name: { userId, name: tagName } },
                create: { userId, name: tagName, color: "#6366f1" },
                update: {},
              });
              await prisma.contactTag.upsert({
                where: { contactId_tagId: { contactId, tagId: tag.id } },
                create: { contactId, tagId: tag.id },
                update: {},
              }).catch(() => {});
            } catch { /* ignore */ }
          }
        }));

        await prisma.importJob.update({
          where: { id: jobId },
          data: { status: "completed", totalFound, imported, deduplicated: skipped, errors, completedAt: new Date() },
        });
      } catch (err: any) {
        console.error("[csv-import worker] failed:", err);
        await prisma.importJob.update({
          where: { id: jobId },
          data: { status: "failed", errorLog: { error: err.message }, completedAt: new Date() },
        }).catch(() => {});
        throw err;
      }
    },
    { connection: redis, concurrency: 2 },
  );

  worker.on("failed", (job, err) => console.error(`[csv-import] job ${job?.id} failed:`, err.message));
  return worker;
}
