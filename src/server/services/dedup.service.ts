import { prisma } from "../lib/prisma";

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, "").replace(/^00/, "+");
}

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

// Used only by Telegram bot intent matching — exact full-name only, never fuzzy
export async function findSimilarContact(name: string, userId?: string): Promise<{ id: string; name: string } | null> {
  const normalized = name.toLowerCase().trim();
  if (normalized.length < 3) return null;

  const contacts = await prisma.contact.findMany({
    where: userId ? { userId } : undefined,
    select: { id: true, name: true },
  });

  for (const c of contacts) {
    const existing = c.name.toLowerCase().trim();
    if (existing.length < 3) continue;
    if (normalized === existing) return c;
  }
  return null;
}

// Safe merge rules: phone match or email match ONLY.
// Name-based matching is completely removed — display names are not unique identifiers
// (many different people share the same name on X/WhatsApp/Telegram).
export async function deduplicateContacts(userId: string): Promise<DeduplicateResult> {
  const contacts = await prisma.contact.findMany({
    where: { userId },
    include: { platforms: true },
    orderBy: { createdAt: "asc" },
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

      // Block: if both contacts already have the same platform type with different IDs,
      // they are definitely different people
      const typesA = new Map<string, string[]>();
      const typesB = new Map<string, string[]>();
      for (const p of a.platforms) {
        if (!typesA.has(p.type)) typesA.set(p.type, []);
        typesA.get(p.type)!.push(normalizePhone(p.platformId));
      }
      for (const p of b.platforms) {
        if (!typesB.has(p.type)) typesB.set(p.type, []);
        typesB.get(p.type)!.push(normalizePhone(p.platformId));
      }

      let hasConflict = false;
      for (const [type, idsA] of typesA) {
        const idsB = typesB.get(type);
        if (!idsB) continue;
        // Any ID overlap between same-type platforms is OK; any mismatch = conflict
        const overlap = idsA.some(id => idsB.includes(id));
        if (!overlap) { hasConflict = true; break; }
      }
      if (hasConflict) continue;

      // 1. Exact phone match (WhatsApp / Telegram phone numbers)
      const phonesA = a.platforms
        .filter(p => p.type === "whatsapp" || p.type === "telegram" || /^\+?\d{7,}$/.test(p.platformId))
        .map(p => normalizePhone(p.platformId))
        .filter(p => p.length >= 7);
      const phonesB = b.platforms
        .filter(p => p.type === "whatsapp" || p.type === "telegram" || /^\+?\d{7,}$/.test(p.platformId))
        .map(p => normalizePhone(p.platformId))
        .filter(p => p.length >= 7);

      outer1:
      for (const pa of phonesA) {
        for (const pb of phonesB) {
          if (pa === pb) { matchReason = `phone: ${pa}`; break outer1; }
        }
      }

      // 2. Exact email match
      if (!matchReason) {
        const emailsA = a.platforms.filter(p => p.type === "email").map(p => p.platformId.toLowerCase());
        const emailsB = b.platforms.filter(p => p.type === "email").map(p => p.platformId.toLowerCase());
        outer2:
        for (const ea of emailsA) {
          for (const eb of emailsB) {
            if (ea === eb) { matchReason = `email: ${ea}`; break outer2; }
          }
        }
      }

      if (matchReason) {
        await mergeContacts(a.id, b.id);
        deleted.add(b.id);
        merges.push({ kept: a.id, merged: b.id, reason: matchReason });
      }
    }
  }

  return { mergedCount: merges.length, merges };
}

// Fix existing wrong merges: any contact that has multiple entries of the same platform
// type with different platform IDs is a bad merge — split each extra into its own contact.
export async function splitWronglyMergedContacts(): Promise<{ split: number }> {
  const contacts = await prisma.contact.findMany({
    include: { platforms: true },
  });

  let split = 0;

  for (const contact of contacts) {
    const byType = new Map<string, Array<typeof contact.platforms[0]>>();
    for (const p of contact.platforms) {
      if (!byType.has(p.type)) byType.set(p.type, []);
      byType.get(p.type)!.push(p);
    }

    for (const [type, entries] of byType) {
      if (entries.length <= 1) continue;

      // Keep the first entry (smallest id = oldest) with the original contact
      entries.sort((a, b) => a.id < b.id ? -1 : 1);
      const [, ...extras] = entries;

      for (const extra of extras) {
        try {
          const newName = extra.displayName || extra.platformId;

          const newContact = await prisma.contact.create({
            data: { userId: contact.userId, name: newName },
          });

          // Move platform record to new contact
          await prisma.platform.update({
            where: { id: extra.id },
            data: { contactId: newContact.id },
          });

          // Move inbox messages that belong to this specific sender.
          // contains (not equals): senderId may be stored as bare digits or as a
          // full JID like 9175...@s.whatsapp.net
          await (prisma as any).inboxMessage.updateMany({
            where: { contactId: contact.id, platform: type as any, senderId: { contains: extra.platformId } },
            data: { contactId: newContact.id, contactName: newName },
          });

          split++;
          console.log(`[split] "${newName}" (${type}: ${extra.platformId}) split from "${contact.name}"`);
        } catch (e: any) {
          console.error(`[split] Failed for ${extra.platformId}:`, e.message);
        }
      }
    }
  }

  console.log(`[split] Done — split ${split} wrongly merged platform(s) into separate contacts`);
  return { split };
}

// Fix contacts duplicated by Beeper using username-as-platformId while native integration
// used numeric ID. Merges pairs that share the same displayName on the same platform.
export async function mergeBeepDuplicates(userId: string): Promise<{ merged: number }> {
  const platforms = await prisma.platform.findMany({
    where: { contact: { userId } },
    select: { id: true, type: true, platformId: true, displayName: true, contactId: true },
  });
  const merged = new Set<string>();
  let count = 0;

  // Group by type+displayName; if two different contacts share the same displayName on the same
  // platform, one is likely from native integration and one from Beeper — merge them.
  const byTypeAndName = new Map<string, typeof platforms>();
  for (const p of platforms) {
    if (!p.displayName) continue;
    // Phone-based platforms identify people by number, and display names there are
    // not unique (multiple "Yogesh" contacts) — never group them by name.
    if (p.type === "whatsapp" || p.type === "telegram") continue;
    const key = `${p.type}::${p.displayName.toLowerCase().trim()}`;
    if (!byTypeAndName.has(key)) byTypeAndName.set(key, []);
    byTypeAndName.get(key)!.push(p);
  }

  for (const [, entries] of byTypeAndName) {
    const contactIds = [...new Set(entries.map((e) => e.contactId))];
    if (contactIds.length < 2) continue;
    // Keep the one with the most messages (most data); merge the rest into it
    const counts = await Promise.all(
      contactIds.map(async (id) => ({
        id,
        n: await (prisma as any).inboxMessage.count({ where: { contactId: id } }),
      }))
    );
    counts.sort((a, b) => b.n - a.n);
    const [keep, ...rest] = counts;
    for (const victim of rest) {
      if (merged.has(victim.id)) continue;
      // Display names are NOT unique identities ("Yours truly" can be two different
      // people). Never merge when the two contacts hold different IDs on the same
      // platform type — that's two different accounts, i.e. two different people.
      const [keepPlats, victimPlats] = await Promise.all([
        prisma.platform.findMany({ where: { contactId: keep.id }, select: { type: true, platformId: true } }),
        prisma.platform.findMany({ where: { contactId: victim.id }, select: { type: true, platformId: true } }),
      ]);
      let conflict = false;
      for (const kp of keepPlats) {
        const sameType = victimPlats.filter((vp) => vp.type === kp.type);
        if (sameType.length > 0 && !sameType.some((vp) => vp.platformId === kp.platformId)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      merged.add(victim.id);
      try {
        await mergeContacts(keep.id, victim.id);
        count++;
        console.log(`[dedup] merged duplicate ${entries[0].type} contact (displayName="${entries[0].displayName}")`);
      } catch (e: any) {
        console.error(`[dedup] failed to merge ${victim.id}:`, e.message);
      }
    }
  }

  console.log(`[dedup] mergeBeepDuplicates done — merged ${count} duplicate contact(s)`);
  return { merged: count };
}

async function mergeContacts(keepId: string, mergeId: string) {
  await (prisma as any).inboxMessage.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } });

  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "contacts"."platforms" SET contact_id = ${keepId}
      WHERE contact_id = ${mergeId}
      AND NOT EXISTS (
        SELECT 1 FROM "contacts"."platforms" p2
        WHERE p2.contact_id = ${keepId} AND p2.type = "contacts"."platforms".type AND p2.platform_id = "contacts"."platforms".platform_id
      )
    `,
    prisma.interaction.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    prisma.note.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    prisma.platform.deleteMany({ where: { contactId: mergeId } }),
    prisma.contact.delete({ where: { id: mergeId } }),
  ]);

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
