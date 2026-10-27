import { downloadPinnedImage } from "../services/candidate-assessment/images.js";
import express from "express";
import { z } from "zod";
import { BlockList, isIP } from "node:net";
import prisma from "../lib/prisma.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { consumeRecruitmentLimit } from "../lib/recruitmentRateLimit.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  kioskStart,
  kioskSession,
  kioskOperate,
  tokenHash,
} from "../services/candidate-assessment/sessions.js";
import logger from "../lib/logger.js";
const router = express.Router();
const Id = z.coerce.number().int().positive(),
  Index = z.coerce.number().int().nonnegative();
const schemas = {
  NEXT_SECTION: z
    .object({
      sectionKey: z.string().min(1).max(80),
      confirmed: z.literal(true),
    })
    .strict(),
  START: z
    .object({ code: z.string().regex(/^\d{6}$/), consent: z.literal(true) })
    .strict(),
  RESPONSE: z
    .object({
      answer: z.union([
        z.number().finite(),
        z.array(z.string().max(40)).max(6),
      ]),
      timeSpentSec: z.number().nonnegative().max(20000),
    })
    .strict(),
  INTEGRITY: z
    .object({ type: z.enum(["FOCUS_LOST", "FULLSCREEN_EXIT", "NETWORK_LOSS"]) })
    .strict(),
};
function networkAllowed(ip) {
  const ranges = (process.env.HR_KIOSK_NETWORK_RANGES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ranges.length) return true;
  const list = new BlockList();
  for (const range of ranges) {
    const [address, prefix] = range.split("/"),
      family = isIP(address);
    if (!family) throw new Error("Invalid kiosk network configuration");
    if (prefix)
      list.addSubnet(address, Number(prefix), family === 6 ? "ipv6" : "ipv4");
    else list.addAddress(address, family === 6 ? "ipv6" : "ipv4");
  }
  const address = String(ip ?? "").replace(/^::ffff:/, "");
  return list.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}
const route = (operation) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  try {
    if (!isRecruitmentFlagEnabled("onsiteTest"))
      return res
        .status(503)
        .json({ error: "Assessment is not enabled", code: "HR-6003" });
    if (!networkAllowed(req.ip))
      return res
        .status(403)
        .json({ error: "Workstation unavailable", code: "HR-6007" });
    await consumeRecruitmentLimit("kiosk:" + operation + ":" + req.ip, {
      limit: operation === "START" ? 8 : 180,
    });
    const raw = req.get("X-Workstation-Token") ?? "",
      tenantId = raw.split(".")[0];
    if (!z.string().uuid().safeParse(tenantId).success || raw.length > 200)
      return res
        .status(401)
        .json({ error: "Workstation unavailable", code: "HR-6007" });
    const input = schemas[operation]?.parse(req.body) ?? {};
    const result = await runWithRequestContext(
      { system: false, user: { tenantId } },
      () =>
        tenantTransaction(
          prisma,
          async (tx) => {
            const now = new Date(),
              env = { tenantId, now };
            const station = await tx.testWorkstation.findFirst({
              where: {
                tenantId,
                deviceTokenHash: tokenHash(raw),
                status: "ACTIVE",
                tokenExpiresAt: { gt: now },
              },
            });
            if (!station)
              throw Object.assign(new Error("Workstation unavailable"), {
                status: 401,
                code: "HR-6007",
              });
            await tx.testWorkstation.update({
              where: { id: station.id },
              data: { lastSeenAt: now },
            });
            if (operation === "START")
              return kioskStart(tx, env, station, input);
            const s = await kioskSession(
              tx,
              env,
              station,
              Id.parse(req.params.id),
              req.get("X-Session-Token"),
            );
            return kioskOperate(tx, env, s, operation, {
              ...input,
              ...(["ITEM", "IMAGE"].includes(operation)
                ? { index: Index.parse(req.params.index) }
                : {}),
              ...(operation === "RESPONSE"
                ? { itemId: Id.parse(req.params.itemId) }
                : {}),
            });
          },
          {
            tenantId,
            txOptions: { isolationLevel: "Serializable", timeout: 30000 },
          },
        ),
    );
    if (operation === "IMAGE" && !result.expired && !result.sectionChanged) {
      const media = await runWithRequestContext(
        { system: false, user: { tenantId } },
        () => downloadPinnedImage(result, tenantId),
      );
      res.set("X-Content-Type-Options", "nosniff");
      return res.type(media.mimeType).send(media.buffer);
    }
    return res
      .status(result.expired ? 410 : result.sectionChanged ? 409 : 200)
      .json(result);
  } catch (e) {
    const status = e instanceof z.ZodError ? 422 : (e.status ?? 500);
    if (status >= 500) logger.error({ err: e }, "Kiosk request failed");
    return res.status(status).json({
      error:
        status >= 500
          ? "The test service is temporarily unavailable"
          : e instanceof z.ZodError
            ? "Invalid request"
            : e.message,
      code: e.code ?? "HR-6000",
    });
  }
};
router.post("/sessions/start", route("START"));
router.get("/sessions/:id", route("STATE"));
router.get("/sessions/:id/items/:index", route("ITEM"));
router.get("/sessions/:id/items/:index/image", route("IMAGE"));
router.put("/sessions/:id/responses/:itemId", route("RESPONSE"));
router.post("/sessions/:id/heartbeat", route("HEARTBEAT"));
router.post("/sessions/:id/integrity-events", route("INTEGRITY"));
router.post("/sessions/:id/next-section", route("NEXT_SECTION"));
router.post("/sessions/:id/submit", route("SUBMIT"));
export default router;
