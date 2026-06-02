import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// Link unlinked contacts (company string matches) to this company via FK
async function autoLinkContacts(companyId: string, companyName: string) {
  await prisma.contact.updateMany({
    where: {
      companyId: null,
      company: { equals: companyName, mode: "insensitive" },
    },
    data: { companyId },
  });
}

// GET /api/companies — list all companies with contact count
// Count includes both FK-linked contacts AND contacts matched by company name string
router.get("/", async (_req, res, next) => {
  try {
    const companies = await prisma.company.findMany({
      include: {
        _count: { select: { contacts: true } },
      },
      orderBy: { name: "asc" },
    });

    // Count unlinked contacts matched by company name (case-insensitive)
    const nameMatchGroups = await prisma.contact.groupBy({
      by: ["company"],
      where: { companyId: null, company: { not: null } },
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
    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // Auto-link any contacts that mention this company by name but lack companyId
    await autoLinkContacts(company.id, company.name);

    const full = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: {
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
    const { name, domain, sector, size, funding, linkedin, website, description } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing name" });
      return;
    }
    const company = await prisma.company.create({
      data: { name, domain, sector, size, funding, linkedin, website, description },
    });
    res.status(201).json(company);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:id — update company
router.put("/:id", async (req, res, next) => {
  try {
    const { name, domain, sector, size, funding, linkedin, website, description } = req.body;
    const company = await prisma.company.update({
      where: { id: req.params.id },
      data: { name, domain, sector, size, funding, linkedin, website, description },
    });
    res.json(company);
  } catch (err) {
    next(err);
  }
});

// POST /api/companies/:id/assign — assign contacts to company
router.post("/:id/assign", async (req, res, next) => {
  try {
    const { contactIds } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: "Missing contactIds array" });
      return;
    }
    await prisma.contact.updateMany({
      where: { id: { in: contactIds } },
      data: { companyId: req.params.id },
    });
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: {
          include: {
            platforms: { select: { type: true, platformId: true, displayName: true } },
          },
        },
        _count: { select: { contacts: true } },
      },
    });
    res.json(company);
  } catch (err) {
    next(err);
  }
});

export default router;
