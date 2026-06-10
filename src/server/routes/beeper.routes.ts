import { Router } from "express";
import { beeperService } from "../services/beeper.service";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/status", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    res.json(await beeperService.getStatus(userId));
  } catch (err) { next(err); }
});

router.post("/connect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    const { matrixId, accessToken, localToken, localEndpoint } = req.body as { matrixId: string; accessToken: string; localToken?: string; localEndpoint?: string };
    if (!matrixId?.trim() || !accessToken?.trim()) {
      res.status(400).json({ error: "matrixId and accessToken are required" });
      return;
    }
    const result = await beeperService.connect(userId, matrixId.trim(), accessToken.trim(), localToken?.trim(), localEndpoint?.trim());
    res.json({ ok: true, matrixId: result.matrixId });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to connect to Beeper Matrix homeserver" });
  }
});

router.delete("/disconnect", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    await beeperService.disconnect(userId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/sync", async (req, res, next) => {
  try {
    const userId = res.locals.session?.user?.id ?? "default";
    // Reset nextBatch and lastSyncAt to force a full reload if requested
    const { full } = req.query as { full?: string };
    if (full === "true") {
      await (prisma as any).beeperSession.update({
        where: { userId },
        data: { nextBatch: null, lastSyncAt: null },
      }).catch(() => {});
    }
    res.json(await beeperService.sync(userId));
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to sync Beeper Matrix rooms" });
  }
});

export default router;
