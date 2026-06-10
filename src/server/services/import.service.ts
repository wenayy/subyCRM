import { prisma } from "../lib/prisma";
import { importFromBeeper } from "../import/beeper";
import { deduplicateContacts } from "./dedup.service";
import { beeperService } from "./beeper.service";
import type { PlatformType } from "@prisma/client";

function profileUrl(platform: string, platformId: string): string | null {
  if (platform === "x") return `https://x.com/${platformId}`;
  if (platform === "telegram") return `https://t.me/${platformId}`;
  if (platform === "linkedin") return `https://linkedin.com/in/${platformId}`;
  return null;
}

export const importService = {
  async runBeeperImport(existingJobId?: string): Promise<string> {
    const jobId = existingJobId ?? (await prisma.importJob.create({
      data: { source: "beeper", status: "running", startedAt: new Date() },
    })).id;

    try {
      // Find user ID from the job
      const job = await prisma.importJob.findUnique({ where: { id: jobId } });
      const userId = job?.userId ?? "default";

      // Check if Beeper Matrix Cloud session is connected
      const session = await (prisma as any).beeperSession.findUnique({ where: { userId } }).catch(() => null);

      if (session && session.connected) {
        console.log(`[import/beeper] Beeper Cloud Matrix API session found for user=${userId}. Syncing...`);
        // Force a full sync to fetch all historic joined rooms and participants
        await (prisma as any).beeperSession.update({
          where: { userId },
          data: { nextBatch: null },
        }).catch(() => {});

        const syncResult = await beeperService.sync(userId);

        await prisma.importJob.update({
          where: { id: jobId },
          data: {
            status: "completed",
            totalFound: syncResult.synced,
            imported: syncResult.importedContacts,
            deduplicated: 0, // Deduplication is run inside beeperService.sync
            errors: 0,
            completedAt: new Date(),
          },
        });
        return jobId;
      }

      // SQLite Fallback path
      const { contacts, errors } = importFromBeeper();
      let imported = 0;
      let skipped = 0;

      await prisma.importJob.update({
        where: { id: jobId },
        data: { totalFound: contacts.length },
      });

      let lastProgressUpdate = Date.now();
      for (const c of contacts) {
        try {
          if (!c.name || c.name.length < 2) { skipped++; continue; }
          if (!c.platformId) { skipped++; continue; }

          // Flush live progress every 3 seconds
          if (Date.now() - lastProgressUpdate > 3000) {
            await prisma.importJob.update({ where: { id: jobId }, data: { imported, errors: skipped } });
            lastProgressUpdate = Date.now();
          }

          // Skip if this platform record already exists
          const existing = await prisma.platform.findFirst({
            where: { type: c.platform as PlatformType, platformId: c.platformId },
          });

          if (existing) {
            // Update lastContactDate if we have newer data
            if (c.lastMessageTs) {
              const contact = await prisma.contact.findUnique({ where: { id: existing.contactId } });
              if (contact && (!contact.lastContactDate || new Date(c.lastMessageTs) > contact.lastContactDate)) {
                await prisma.contact.update({
                  where: { id: existing.contactId },
                  data: { lastContactDate: new Date(c.lastMessageTs) },
                });
              }
            }
            skipped++;
            continue;
          }

          await prisma.contact.create({
            data: {
              userId,
              name: c.name,
              lastContactDate: c.lastMessageTs ? new Date(c.lastMessageTs) : null,
              platforms: {
                create: [{
                  type: c.platform as PlatformType,
                  platformId: c.platformId,
                  displayName: c.name,
                  profileUrl: profileUrl(c.platform, c.platformId),
                }],
              },
            },
          });
          imported++;
        } catch {
          skipped++;
        }
      }

      // Sync and decrypt local messages for fallback SQLite path too
      try {
        const { decryptEncryptedMessages, syncLocalMessagesForContacts } = await import("../import/beeper");
        const localSyncedResult = await syncLocalMessagesForContacts(userId);
        const decryptedCount = await decryptEncryptedMessages(userId);
        console.log(`[import/beeper] Local SQLite sync complete: synced ${localSyncedResult.synced} messages, decrypted ${decryptedCount} messages`);
      } catch (localErr: any) {
        console.error("[import/beeper] Local SQLite message sync failed (non-fatal):", localErr.message);
      }

      let dedupCount = 0;
      if (imported > 0) {
        try {
          console.log(`[import/beeper] Running deduplication...`);
          const dedup = await deduplicateContacts();
          dedupCount = dedup.mergedCount;
        } catch (dedupErr) {
          console.error("[import/beeper] Deduplication failed (non-fatal):", dedupErr);
        }
      }

      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          imported,
          deduplicated: dedupCount,
          errors: skipped,
          errorLog: errors.length > 0 ? errors : undefined,
          completedAt: new Date(),
        },
      });

      console.log(`[import/beeper] Done: ${imported} imported, ${dedupCount} deduped, ${skipped} skipped`);
      return jobId;
    } catch (err) {
      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          errorLog: { error: err instanceof Error ? err.message : String(err) },
          completedAt: new Date(),
        },
      });
      throw err;
    }
  },
};
