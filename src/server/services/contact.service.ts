import { prisma } from "../lib/prisma";
import type { Prisma } from "@prisma/client";

function normalizePlatformId(type: string, id: string): string {
  if (type === "linkedin") {
    // Accept: full URL, URL without protocol, or just slug — always store the slug
    const match = id.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (match) return match[1];
  }
  return id.trim();
}

export const contactService = {
  async getAll(userId: string, filters: {
    type?: string;
    domain?: string;
    strength?: string;
    tag?: string;
    search?: string;
    stale_days?: number;
    page?: number;
    limit?: number;
  } = {}) {
    const page = filters.page ? Math.max(0, filters.page - 1) : 0;
    const limit = filters.limit ?? 20;
    const where: Prisma.ContactWhereInput = { userId };
    const whereAnd: Prisma.ContactWhereInput[] = [];

    if (filters.type) where.type = filters.type as any;
    if (filters.domain) where.domain = filters.domain as any;
    if (filters.strength) where.relationshipStrength = filters.strength as any;

    if (filters.search) {
      const terms = filters.search.trim().split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        terms.forEach((term) => {
          whereAnd.push({
            OR: [
              { name: { contains: term, mode: "insensitive" } },
              { company: { contains: term, mode: "insensitive" } },
              { role: { contains: term, mode: "insensitive" } },
              {
                companyRef: {
                  name: { contains: term, mode: "insensitive" },
                },
              },
              {
                platforms: {
                  some: {
                    OR: [
                      { platformId: { contains: term, mode: "insensitive" } },
                      { displayName: { contains: term, mode: "insensitive" } },
                    ],
                  },
                },
              },
            ],
          });
        });
      }
    }

    if (filters.tag) {
      where.contactTags = { some: { tag: { name: filters.tag } } };
    }

    if (filters.stale_days) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - filters.stale_days);
      // Stale = lastContactDate before cutoff OR null
      whereAnd.push({
        OR: [
          { lastContactDate: { lt: cutoff } },
          { lastContactDate: null },
        ],
      });
    }

    if (whereAnd.length > 0) {
      where.AND = whereAnd;
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { lastContactDate: { sort: "desc", nulls: "last" } },
        skip: page * limit,
        take: limit,
        include: {
          platforms: { select: { type: true, platformId: true, displayName: true } },
          _count: { select: { platforms: true } },
          interactions: {
            orderBy: { occurredAt: "desc" },
            take: 1,
            select: { occurredAt: true, platform: true },
          },
          contactTags: {
            include: { tag: true },
          },
        },
      }),
      prisma.contact.count({ where }),
    ]);

    return {
      data: contacts.map((c) => ({
        ...c,
        platforms: c.platforms,
        platformsCount: c._count.platforms,
        lastInteraction: c.interactions[0] || null,
        _count: undefined,
        interactions: undefined,
      })),
      total,
      page,
      limit,
    };
  },

  async getStats(userId: string) {
    const now = new Date();
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const d60 = new Date(now); d60.setDate(d60.getDate() - 60);
    const d90 = new Date(now); d90.setDate(d90.getDate() - 90);

    const [total, byType, byDomain, byStrength, stale30, stale60, stale90] =
      await Promise.all([
        prisma.contact.count({ where: { userId } }),
        prisma.contact.groupBy({ by: ["type"], where: { userId }, _count: true }),
        prisma.contact.groupBy({ by: ["domain"], where: { userId }, _count: true }),
        prisma.contact.groupBy({ by: ["relationshipStrength"], where: { userId }, _count: true }),
        prisma.contact.count({
          where: { userId, OR: [{ lastContactDate: { lt: d30 } }, { lastContactDate: null }] },
        }),
        prisma.contact.count({
          where: { userId, OR: [{ lastContactDate: { lt: d60 } }, { lastContactDate: null }] },
        }),
        prisma.contact.count({
          where: { userId, OR: [{ lastContactDate: { lt: d90 } }, { lastContactDate: null }] },
        }),
      ]);

    return {
      total,
      byType: Object.fromEntries(byType.map((r) => [r.type, r._count])),
      byDomain: Object.fromEntries(byDomain.map((r) => [r.domain, r._count])),
      byStrength: Object.fromEntries(byStrength.map((r) => [r.relationshipStrength, r._count])),
      stale30,
      stale60,
      stale90,
    };
  },

  async getById(userId: string, id: string) {
    return prisma.contact.findFirst({
      where: { id, userId },
      include: {
        platforms: true,
        notes: { orderBy: { createdAt: "desc" }, take: 20 },
        contactTags: { include: { tag: true } },
        interactions: { orderBy: { occurredAt: "desc" }, take: 50 },
      },
    });
  },

  async create(userId: string, data: {
    name: string;
    type?: string;
    domain?: string;
    company?: string;
    role?: string;
    relationshipStrength?: string;
    platforms?: Array<{
      type: string;
      platformId: string;
      displayName?: string;
      profileUrl?: string;
    }>;
  }) {
    const { platforms, ...contactData } = data;
    const contact = await prisma.contact.create({
      data: { ...contactData as any, userId },
      include: { platforms: true },
    });
    if (platforms?.length) {
      for (const p of platforms) {
        const normalizedId = normalizePlatformId(p.type, p.platformId);
        await prisma.platform.create({
          data: { contactId: contact.id, type: p.type as any, platformId: normalizedId, displayName: p.displayName },
        }).catch(() => {}); // ignore duplicate platform errors
      }
      return prisma.contact.findUnique({ where: { id: contact.id }, include: { platforms: true } }) as any;
    }
    return contact;
  },

  async update(userId: string, id: string, data: Record<string, unknown>) {
    // Strip relations from update
    const { platforms, notes, contactTags, interactions, ...fields } = data;
    return prisma.contact.update({
      where: { id, userId },
      data: fields as any,
      include: { platforms: true },
    });
  },

  async delete(userId: string, id: string) {
    return prisma.contact.delete({ where: { id, userId } });
  },

  async merge(userId: string, keepId: string, mergeWithId: string) {
    // Move all related records from mergeWithId to keepId, then delete mergeWithId
    return prisma.$transaction(async (tx) => {
      // Verify both contacts belong to userId
      const [keep, mergeWith] = await Promise.all([
        tx.contact.findFirst({ where: { id: keepId, userId } }),
        tx.contact.findFirst({ where: { id: mergeWithId, userId } }),
      ]);
      if (!keep || !mergeWith) throw new Error("Contact not found or access denied");

      // Move platforms (skip duplicates by catching unique constraint errors)
      await tx.platform.updateMany({
        where: { contactId: mergeWithId },
        data: { contactId: keepId },
      });

      // Move interactions
      await tx.interaction.updateMany({
        where: { contactId: mergeWithId },
        data: { contactId: keepId },
      });

      // Move notes
      await tx.note.updateMany({
        where: { contactId: mergeWithId },
        data: { contactId: keepId },
      });

      // Move tags (delete duplicates first)
      const existingTags = await tx.contactTag.findMany({
        where: { contactId: keepId },
        select: { tagId: true },
      });
      const existingTagIds = new Set(existingTags.map((t) => t.tagId));

      // Delete tags on mergeWith that already exist on keep
      await tx.contactTag.deleteMany({
        where: {
          contactId: mergeWithId,
          tagId: { in: Array.from(existingTagIds) },
        },
      });

      // Move remaining tags
      await tx.contactTag.updateMany({
        where: { contactId: mergeWithId },
        data: { contactId: keepId },
      });

      // Update lastContactDate on keep contact to the most recent
      const mergedContact = await tx.contact.findUnique({
        where: { id: mergeWithId },
        select: { lastContactDate: true, firstContactDate: true },
      });

      if (mergedContact) {
        const keepContact = await tx.contact.findUnique({
          where: { id: keepId },
          select: { lastContactDate: true, firstContactDate: true },
        });

        const updates: Record<string, Date> = {};
        if (
          mergedContact.lastContactDate &&
          (!keepContact?.lastContactDate || mergedContact.lastContactDate > keepContact.lastContactDate)
        ) {
          updates.lastContactDate = mergedContact.lastContactDate;
        }
        if (
          mergedContact.firstContactDate &&
          (!keepContact?.firstContactDate || mergedContact.firstContactDate < keepContact.firstContactDate)
        ) {
          updates.firstContactDate = mergedContact.firstContactDate;
        }

        if (Object.keys(updates).length > 0) {
          await tx.contact.update({ where: { id: keepId }, data: updates });
        }
      }

      // Delete the merged contact
      await tx.contact.delete({ where: { id: mergeWithId } });

      // Return the updated keep contact
      return tx.contact.findUnique({
        where: { id: keepId },
        include: {
          platforms: true,
          notes: { orderBy: { createdAt: "desc" }, take: 20 },
          contactTags: { include: { tag: true } },
          interactions: { orderBy: { occurredAt: "desc" }, take: 50 },
        },
      });
    });
  },

  async addPlatform(userId: string, contactId: string, data: { type: string; platformId: string; displayName?: string; profileUrl?: string }) {
    const normalizedId = normalizePlatformId(data.type, data.platformId);
    const existing = await prisma.platform.findFirst({
      where: { type: data.type as any, platformId: normalizedId, contact: { userId } },
    });
    let platform;
    if (existing) {
      // Move to this contact if it belongs to someone else, else just return it
      if (existing.contactId !== contactId) {
        platform = await prisma.platform.update({ where: { id: existing.id }, data: { contactId } });
      } else {
        platform = existing;
      }
    } else {
      platform = await prisma.platform.create({
        data: { contactId, type: data.type as any, platformId: normalizedId, displayName: data.displayName, profileUrl: data.profileUrl },
      });
    }

    // Link existing messages that match this platform
    if (platform) {
      const { inboxService } = await import("./inbox.service");
      await inboxService.linkMessagesToContact(contactId, platform.type, platform.platformId);
    }
    return platform;
  },

  async updatePlatform(userId: string, contactId: string, platformDbId: string, data: { platformId?: string; displayName?: string; profileUrl?: string; type?: string }) {
    const normalizedId = data.platformId && data.type ? normalizePlatformId(data.type, data.platformId) : data.platformId;
    // Verify the contact belongs to userId
    const contact = await prisma.contact.findFirst({ where: { id: contactId, userId } });
    if (!contact) throw new Error("Contact not found or access denied");
    return prisma.platform.update({
      where: { id: platformDbId, contactId },
      data: { ...(normalizedId && { platformId: normalizedId }), displayName: data.displayName, profileUrl: data.profileUrl },
    });
  },

  async deletePlatform(userId: string, contactId: string, platformDbId: string) {
    // Verify the contact belongs to userId
    const contact = await prisma.contact.findFirst({ where: { id: contactId, userId } });
    if (!contact) throw new Error("Contact not found or access denied");
    await prisma.platform.delete({ where: { id: platformDbId, contactId } });
  },
};
