import { Router } from "express";
import { handleMatrixTransaction } from "../services/matrix-bridge.service";

const router = Router();

// Matrix appservice spec: Conduit pushes events here
// Auth: Bearer token must match MATRIX_AS_TOKEN env var
router.put("/transactions/:txnId", async (req, res) => {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.replace("Bearer ", "").trim();
  const expected = process.env.MATRIX_AS_TOKEN ?? "";

  if (!expected || token !== expected) {
    res.status(403).json({ errcode: "M_FORBIDDEN", error: "Bad token" });
    return;
  }

  // Matrix spec: always 200 even on partial failure, to prevent re-delivery spam
  try {
    const events = req.body?.events ?? [];
    // userId comes from AS token — find owner of this token
    const userId = process.env.MATRIX_BRIDGE_OWNER_USER_ID ?? "default";
    await handleMatrixTransaction(req.params.txnId, events, userId);
  } catch (err) {
    console.error("[matrix-bridge] transaction error:", err);
  }

  res.json({});
});

export default router;
