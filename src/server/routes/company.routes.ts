import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// Link unlinked contacts (company string matches) to this company via FK
async function autoLinkContacts(companyId: string, companyName: string, userId: string) {
  await prisma.contact.updateMany({
    where: {
      userId,
      companyId: null,
      company: { equals: companyName, mode: "insensitive" },
    },
    data: { companyId },
  });
}

// GET /api/companies — list companies for current user with contact count
router.get("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const companies = await prisma.company.findMany({
      where: { userId },
      include: {
        _count: { select: { contacts: true } },
      },
      orderBy: { name: "asc" },
    });

    // Count unlinked contacts matched by company name (case-insensitive) for this user
    const nameMatchGroups = await prisma.contact.groupBy({
      by: ["company"],
      where: { userId, companyId: null, company: { not: null } },
      _count: { _all: true },
    });
    const nameMatchMap = new Map(
      nameMatchGroups.map((g) => [g.company!.toLowerCase(), g._count._all])
    );

    res.json(
      companies.map((c) => ({
        ...c,
        contactCount: c._count.contacts + (nameMatchMap.get(c.name.toLowerCase()) ?? 0),
        _count: undefined,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/companies/:id — single company with all contacts (auto-links by name first)
router.get("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const company = await prisma.company.findFirst({ where: { id: req.params.id, userId } });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // Auto-link any contacts that mention this company by name but lack companyId
    await autoLinkContacts(company.id, company.name, userId);

    const full = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: {
          where: { userId },
          include: {
            platforms: { select: { type: true, platformId: true, displayName: true } },
          },
          orderBy: { name: "asc" },
        },
      },
    });
    res.json(full);
  } catch (err) {
    next(err);
  }
});

// POST /api/companies — create company
router.post("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { name, domain, sector, size, funding, linkedin, website, description } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing name" });
      return;
    }
    const company = await prisma.company.create({
      data: { userId, name, domain, sector, size, funding, linkedin, website, description },
    });
    res.status(201).json(company);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:id — update company
router.put("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { name, domain, sector, size, funding, linkedin, website, description } = req.body;
    // Verify ownership
    const existing = await prisma.company.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) { res.status(404).json({ error: "Company not found" }); return; }
    const company = await prisma.company.update({
      where: { id: req.params.id },
      data: { name, domain, sector, size, funding, linkedin, website, description },
    });
    res.json(company);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/companies/:id/contacts/:contactId — remove a contact from a company
// (e.g. enrichment linked the wrong person). Clears the legacy company text too,
// otherwise autoLinkContacts would immediately re-link it by name.
router.delete("/:id/contacts/:contactId", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const company = await prisma.company.findFirst({ where: { id: req.params.id, userId } });
    if (!company) { res.status(404).json({ error: "Company not found" }); return; }

    const { count } = await prisma.contact.updateMany({
      where: { id: req.params.contactId, userId, companyId: req.params.id },
      data: { companyId: null, company: null },
    });
    if (count === 0) { res.status(404).json({ error: "Contact not found in this company" }); return; }
    const { cache } = await import("../lib/cache");
    await cache.invalidateContacts().catch(() => {});
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/companies/:id/assign — assign contacts to company
router.post("/:id/assign", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { contactIds } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: "Missing contactIds array" });
      return;
    }
    // Verify company belongs to user
    const company = await prisma.company.findFirst({ where: { id: req.params.id, userId } });
    if (!company) { res.status(404).json({ error: "Company not found" }); return; }

    await prisma.contact.updateMany({
      where: { id: { in: contactIds }, userId },
      data: { companyId: req.params.id },
    });
    const full = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: {
          where: { userId },
          include: {
            platforms: { select: { type: true, platformId: true, displayName: true } },
          },
        },
        _count: { select: { contacts: true } },
      },
    });
    res.json(full);
  } catch (err) {
    next(err);
  }
});

export default router;
