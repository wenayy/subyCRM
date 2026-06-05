import { prisma } from "../lib/prisma";

// Normalize phone numbers for comparison
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, "").replace(/^00/, "+");
}

// Simple Levenshtein distance
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
  return dp[m][n];
}

interface DeduplicateResult {
  mergedCount: number;
  merges: { kept: string; merged: string; reason: string }[];
}

// Check if a contact with a similar name already exists before creating a new one.
// Returns the existing contact if found, null otherwise.
export async function findSimilarContact(name: string, userId?: string): Promise<{ id: string; name: string } | null> {
  const normalized = name.toLowerCase().trim();
  if (normalized.length < 3) return null;
  const contacts = await prisma.contact.findMany({
    where: userId ? { userId } : undefined,
    select: { id: true, name: true },
  });
  for (const c of contacts) {
    const existing = c.name.toLowerCase().trim();
    if (levenshtein(normalized, existing) <= 2) return c;
    if (normalized.includes(existing) || existing.includes(normalized)) return c;
  }
  return null;
}

export async function deduplicateContacts(): Promise<DeduplicateResult> {
  const contacts = await prisma.contact.findMany({
    include: { platforms: true },
    orderBy: { createdAt: "asc" }, // keep oldest
  });

  const merges: { kept: string; merged: string; reason: string }[] = [];
  const deleted = new Set<string>();

  for (let i = 0; i < contacts.length; i++) {
    if (deleted.has(contacts[i].id)) continue;

    for (let j = i + 1; j < contacts.length; j++) {
      if (deleted.has(contacts[j].id)) continue;

      const a = contacts[i];
      const b = contacts[j];
      let matchReason = "";

      // 1. Exact phone match
      const phonesA = a.platforms.filter(p => p.platformId.startsWith("+") || p.type === "whatsapp").map(p => normalizePhone(p.platformId));
      const phonesB = b.platforms.filter(p => p.platformId.startsWith("+") || p.type === "whatsapp").map(p => normalizePhone(p.platformId));
      for (const pa of phonesA) {
        for (const pb of phonesB) {
          if (pa && pb && pa === pb) matchReason = `phone: ${pa}`;
        }
      }

      // 2. Exact email match
      if (!matchReason) {
        const emailsA = a.platforms.filter(p => p.type === "email").map(p => p.platformId.toLowerCase());
        const emailsB = b.platforms.filter(p => p.type === "email").map(p => p.platformId.toLowerCase());
        for (const ea of emailsA) {
          for (const eb of emailsB) {
            if (ea && eb && ea === eb) matchReason = `email: ${ea}`;
          }
        }
      }

      // 3. Fuzzy name match (Levenshtein < 3) + same company
      if (!matchReason) {
        const nameA = a.name.toLowerCase().trim();
        const nameB = b.name.toLowerCase().trim();
        if (nameA.length >= 3 && nameB.length >= 3 && levenshtein(nameA, nameB) <= 2) {
          // Same name, check if company matches or both have no company
          if (a.company && b.company && a.company.toLowerCase() === b.company.toLowerCase()) {
            matchReason = `fuzzy name + company: ${a.name} / ${b.name}`;
          } else if (!a.company && !b.company) {
            matchReason = `fuzzy name: ${a.name} / ${b.name}`;
          }
        }
      }

      if (matchReason) {
        // Merge b into a (a is older, keep it)
        await mergeContacts(a.id, b.id);
        deleted.add(b.id);
        merges.push({ kept: a.id, merged: b.id, reason: matchReason });
      }
    }
  }

  return { mergedCount: merges.length, merges };
}

async function mergeContacts(keepId: string, mergeId: string) {
  // Move inbox messages before the transaction (updateMany not in $transaction for dynamic models)
  await (prisma as any).inboxMessage.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } });

  await prisma.$transaction([
    // Move platforms (skip duplicates)
    prisma.$executeRaw`
      UPDATE "contacts"."platforms" SET contact_id = ${keepId}
      WHERE contact_id = ${mergeId}
      AND NOT EXISTS (
        SELECT 1 FROM "contacts"."platforms" p2
        WHERE p2.contact_id = ${keepId} AND p2.type = "contacts"."platforms".type AND p2.platform_id = "contacts"."platforms".platform_id
      )
    `,
    // Move interactions
    prisma.interaction.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    // Move notes
    prisma.note.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    // Delete duplicate platforms
    prisma.platform.deleteMany({ where: { contactId: mergeId } }),
    // Delete merged contact
    prisma.contact.delete({ where: { id: mergeId } }),
  ]);

  // Update last contact date on the kept contact
  const lastInteraction = await prisma.interaction.findFirst({
    where: { contactId: keepId },
    orderBy: { occurredAt: "desc" },
  });
  if (lastInteraction) {
    await prisma.contact.update({
      where: { id: keepId },
      data: { lastContactDate: lastInteraction.occurredAt },
    });
  }
}
