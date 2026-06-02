import { Router } from "express";
import { prisma } from "../lib/prisma";
import { Interaction } from "@prisma/client";

export const timelineRouter = Router();

// GET /api/contacts/:id/timeline
// Query params: limit (default 30), offset (default 0), channels (comma‑separated)
// Returns interactions ordered chronologically (oldest first)

timelineRouter.get("/contacts/:id/timeline", async (req, res, next) => {
  try {
    const contactId = req.params.id as string;
    const limit = Number(req.query.limit) || 30;
    const offset = Number(req.query.offset) || 0;
    const channels = (req.query.channels as string | undefined)?.split(",");

    const where: any = { contactId };
    if (channels?.length) {
      where.platform = { in: channels };
    }
    const interactions = await prisma.interaction.findMany({
      where,
      orderBy: { occurredAt: "asc" },
      skip: offset,
      take: limit,
    });
    res.json(interactions);
  } catch (err) {
    next(err);
  }
});
