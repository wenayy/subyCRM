import { Router } from "express";
import { inboxService } from "../services/inbox.service";
import { registerSSEClient, removeSSEClient } from "../services/sse.service";
import fs from "fs/promises";
import path from "path";

const router = Router();

// SSE endpoint — clients connect here and get push events when messages arrive
router.get("/events", (req, res) => {
  const id = `${Date.now()}-${Math.random()}`;
  registerSSEClient(id, res);
  req.on("close", () => removeSSEClient(id));
});

router.get("/conversations", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await inboxService.getConversations(userId));
  } catch (err) { next(err); }
});

router.get("/thread", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { contactId, platform } = req.query as { contactId: string; platform: string };
    if (!contactId || !platform) { res.status(400).json({ error: "contactId and platform required" }); return; }
    res.json(await inboxService.getThread(contactId, platform, userId));
  } catch (err) { next(err); }
});

router.get("/thread-more", async (req, res, next) => {
  try {
    const { contactId, platform, before, limit } = req.query as { contactId: string; platform: string; before: string; limit?: string };
    if (!contactId || !platform || !before) { res.status(400).json({ error: "contactId, platform, before required" }); return; }
    res.json(await inboxService.getThreadBefore(contactId, platform, new Date(before), parseInt(limit ?? "50") || 50));
  } catch (err) { next(err); }
});

router.post("/subscribe-presence", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { jid } = req.body as { jid: string };
    if (jid) {
      const { whatsappService } = await import("../services/whatsapp.service");
      void whatsappService.subscribePresence(jid, userId).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// All messages for a contact across all platforms — used by contact detail view
router.get("/contact/:contactId", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await inboxService.getContactMessages(req.params.contactId, userId));
  } catch (err) { next(err); }
});

router.get("/", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const messages = await inboxService.getMessages({ limit: 100 }, userId);
    res.json(messages);
  } catch (err) { next(err); }
});

router.get("/stats", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await inboxService.getStats(userId));
  } catch (err) { next(err); }
});

router.post("/mark-read", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { contactId, platform } = req.body as { contactId: string; platform: string };
    if (!contactId || !platform) { res.status(400).json({ error: "contactId and platform required" }); return; }
    await inboxService.markConversationRead(contactId, platform, userId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get("/unknown-thread", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { senderId, platform } = req.query as { senderId: string; platform: string };
    if (!senderId || !platform) { res.status(400).json({ error: "senderId and platform required" }); return; }
    res.json(await inboxService.getUnknownThread(senderId, platform, userId));
  } catch (err) { next(err); }
});

router.post("/mark-unknown-read", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { senderId, platform } = req.body as { senderId: string; platform: string };
    if (!senderId || !platform) { res.status(400).json({ error: "senderId and platform required" }); return; }
    await inboxService.markUnknownConversationRead(senderId, platform, userId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await inboxService.deleteMessage(req.params.id, userId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { read, starred } = req.body as { read?: boolean; starred?: boolean };
    res.json(await inboxService.updateMessage(req.params.id, { read, starred }, userId));
  } catch (err) { next(err); }
});

router.post("/:id/react", async (req, res, next) => {
  try {
    const { emoji } = req.body as { emoji: string };
    if (!emoji) { res.status(400).json({ error: "emoji required" }); return; }
    const userId = res.locals.session?.user?.id;
    // Fire-and-forget — reactions are low-stakes and we don't want to block the
    // HTTP response for 35s while waiting for a WhatsApp reconnect.
    void inboxService.react(req.params.id, emoji, userId).catch((e) =>
      console.error("[inbox] Background reaction failed:", e)
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/:id/reply", async (req, res, next) => {
  try {
    const { body, replyToId, contactId, platform, senderId } = req.body as {
      body: string; replyToId?: string;
      contactId?: string; platform?: string; senderId?: string;
    };
    if (!body?.trim()) { res.status(400).json({ error: "body required" }); return; }
    const userId = res.locals.session?.user?.id;
    await inboxService.reply(req.params.id, body.trim(), userId, replyToId, { contactId, platform, senderId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/archive", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { contactId, senderId, platform } = req.body as { contactId?: string; senderId?: string; platform: string };
    await inboxService.archiveConversation({ contactId, senderId, platform, userId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/unarchive", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { contactId, senderId, platform } = req.body as { contactId?: string; senderId?: string; platform: string };
    await inboxService.unarchiveConversation({ contactId, senderId, platform, userId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/upload", async (req, res, next) => {
  try {
    const { filename, fileData } = req.body as { filename: string; fileData: string };
    if (!filename || !fileData) {
      res.status(400).json({ error: "filename and fileData required" });
      return;
    }

    const base64Data = fileData.split(";base64,").pop();
    if (!base64Data) {
      res.status(400).json({ error: "Invalid base64 data format" });
      return;
    }

    const buffer = Buffer.from(base64Data, "base64");
    const uniqueName = `${Date.now()}_${filename.replace(/\s+/g, "_")}`;
    const mediaDir = path.join(process.cwd(), "public", "media");
    await fs.mkdir(mediaDir, { recursive: true });

    await fs.writeFile(path.join(mediaDir, uniqueName), buffer);

    res.json({ url: `/media/${uniqueName}` });
  } catch (err) {
    next(err);
  }
});

export default router;
