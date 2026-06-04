import { Router } from "express";
import { prisma } from "../lib/prisma";
import { broadcastInboxEvent } from "../services/sse.service";

const router = Router();

// GET /api/reminders — list pending reminders sorted by dueDate asc (scoped to user via contact)
router.get("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const reminders = await prisma.reminder.findMany({
      where: { status: "pending", contact: { userId } },
      orderBy: { dueDate: "asc" },
      include: {
        contact: { select: { id: true, name: true } },
      },
    });
    res.json(reminders);
  } catch (err) {
    next(err);
  }
});

// GET /api/reminders/due — overdue reminders (dueDate <= now, status = pending)
router.get("/due", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const reminders = await prisma.reminder.findMany({
      where: {
        status: "pending",
        dueDate: { lte: new Date() },
        contact: { userId },
      },
      orderBy: { dueDate: "asc" },
      include: {
        contact: { select: { id: true, name: true } },
      },
    });
    res.json(reminders);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/reminders — create reminder for a contact
const contactReminderRouter = Router();

contactReminderRouter.post("/:id/reminders", async (req, res, next) => {
  try {
    const { content, dueDate } = req.body;
    if (!content || !dueDate) {
      res.status(400).json({ error: "Missing content or dueDate" });
      return;
    }
    const reminder = await prisma.reminder.create({
      data: {
        contactId: req.params.id,
        content,
        dueDate: new Date(dueDate),
      },
      include: {
        contact: { select: { id: true, name: true } },
      },
    });
    broadcastInboxEvent("reminder_created", { id: reminder.id });
    res.status(201).json(reminder);
  } catch (err) {
    next(err);
  }
});

// PUT /api/reminders/:id — update status or content/dueDate
router.put("/:id", async (req, res, next) => {
  try {
    const { status, content, dueDate } = req.body;
    const data: Record<string, unknown> = {};
    if (status) data.status = status;
    if (content) data.content = content;
    if (dueDate) data.dueDate = new Date(dueDate);

    const reminder = await prisma.reminder.update({
      where: { id: req.params.id },
      data,
      include: {
        contact: { select: { id: true, name: true } },
      },
    });
    broadcastInboxEvent("reminder_updated", { id: reminder.id });
    res.json(reminder);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/reminders/:id — delete reminder
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.reminder.delete({ where: { id: req.params.id } });
    broadcastInboxEvent("reminder_deleted", { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export { contactReminderRouter };
export default router;
