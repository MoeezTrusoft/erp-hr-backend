// tests/unit/recruitmentIdempotency.test.js
//
// Phase 14 — "idempotency" from the plan's named negative-path list.
//
// The idempotency MIDDLEWARE has its own unit suite (middlewares/
// idempotency.middleware.test.js: replay, non-2xx not cached, tenant
// namespacing). What was missing is the recruitment WIRING: a duplicate
// submission of the same mutating request must not create a second business
// object. These tests pin:
//
//   1. the middleware is mounted on the create surfaces where a retry would
//      duplicate a business object (candidate / application / offer);
//   2. end-to-end through the middleware: the SAME Idempotency-Key replays
//      the FIRST response — the service (and its create) runs exactly once.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── 1. the wiring is pinned structurally ────────────────────────────────────
// (An import-order refactor that silently drops the middleware must fail here,
// not only at runtime when the first duplicate hits production.)

const recruitmentRoutes = readFileSync(path.join(root, "src/routes/recruitment.routes.js"), "utf8");
const offerRoutes = readFileSync(path.join(root, "src/routes/offer.routes.js"), "utf8");

describe("recruitment create routes carry idempotency (Phase 14 wiring)", () => {
    it("mounts idempotency on candidate create", () => {
        expect(recruitmentRoutes).toMatch(/router\.post\("\/candidates",\s*createIdempotency,\s*createCandidate\)/);
    });
    it("mounts idempotency on application create", () => {
        expect(recruitmentRoutes).toMatch(/router\.post\("\/applications",\s*createIdempotency,\s*createApplication\)/);
    });
    it("mounts idempotency on offer create", () => {
        expect(offerRoutes).toMatch(/router\.post\("\/",\s*idempotency\(\),\s*ctrl\.createOffer\)/);
    });
    it("does NOT wrap deliberate compliance actions", () => {
        // Erasure/anonymize is a deliberate act, never a retried accident.
        expect(recruitmentRoutes).not.toMatch(/createIdempotency[\s\S]{0,120}anonymizeCandidateHandler/);
    });
});

// ── 2. end-to-end through the middleware ────────────────────────────────────

const prisma = {
    $transaction: (fn) => fn(prisma),
    jobRequisition: { findFirst: jest.fn() },
    application: { create: jest.fn(), findFirst: jest.fn() },
    candidate: { findFirst: jest.fn(async () => ({ id: 11, email: "c11@example.com" })) },
    // Phase 2 / D-11 — the intake probes the do-not-contact register.
    candidateDncEntry: { findFirst: jest.fn(async () => null) },
    applicationStageHistory: { create: jest.fn(async () => ({})) }, // §3 stage-history row written in the same tx
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const memoryStore = (await import("../../src/lib/idempotency-store.js")).createMemoryStore({ ttlMs: 60_000 });
const { idempotency } = await import("../../src/middlewares/idempotency.middleware.js");
const { createApplication } = await import("../../src/services/applicationService.js");

function mockReq({ key, body = {} }) {
    return {
        method: "POST",
        path: "/api/recruitment/applications",
        headers: key ? { "idempotency-key": key } : {},
        body,
        user: { tenantId: "t-1", userId: "u-1" },
    };
}
function mockRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

// The express middleware invokes next() without awaiting an async handler;
// wrap the handler's completion so the tests are deterministic. NB: on a
// COMPLETED replay the middleware answers directly and never calls next() —
// resolve when either the handler finished OR the response was written.
async function runOnce(req, handler) {
    const res = mockRes();
    const mw = idempotency({ store: memoryStore });
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        const json = res.json;
        res.json = (payload) => { const r = json.call(res, payload); finish(); return r; };
        mw(req, res, () => {
            Promise.resolve()
                .then(() => handler(res))
                .then(finish, reject);
        });
    });
    return res;
}

const REQ = { id: 7, tenantId: "t-1", postings: [{ isActive: true }], isActive: true, closingDate: null, autoCloseWhenFilled: false, openCount: 1, openings: 2, status: "POSTED" };

const appHandler = async (res) => {
    const app = await createApplication({ candidateId: 11, jobRequisitionId: 7, tenantId: "t-1", createdById: 1 });
    res.status(201).json({ success: true, data: app });
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.jobRequisition.findFirst.mockResolvedValue(REQ);
    prisma.application.create.mockImplementation(async ({ data }) => ({ id: 101, ...data }));
});

describe("duplicate application submission with an Idempotency-Key (Phase 14 e2e)", () => {
    it("the service runs ONCE; the retry replays the first 201 without re-applying", async () => {
        const first = await runOnce(mockReq({ key: "apply-11-7", body: { candidateId: 11, jobRequisitionId: 7 } }), appHandler);
        expect(first.statusCode).toBe(201);
        expect(prisma.application.create).toHaveBeenCalledTimes(1);

        // Network retry: same key, same path — the handler (and the create)
        // must not run again; the cached 201 replays.
        const retry = await runOnce(mockReq({ key: "apply-11-7", body: { candidateId: 11, jobRequisitionId: 7 } }), appHandler);
        expect(retry.statusCode).toBe(201);
        expect(retry.body).toEqual(first.body);
        expect(prisma.application.create).toHaveBeenCalledTimes(1); // still once
    });

    it("a DIFFERENT key is a different submission and reaches the service again", async () => {
        await runOnce(mockReq({ key: "key-A" }), appHandler);
        await runOnce(mockReq({ key: "key-B" }), appHandler);
        expect(prisma.application.create).toHaveBeenCalledTimes(2);
    });

    it("no key at all behaves exactly as before (opt-in)", async () => {
        await runOnce(mockReq({ body: { candidateId: 11 } }), appHandler);
        await runOnce(mockReq({ body: { candidateId: 11 } }), appHandler);
        expect(prisma.application.create).toHaveBeenCalledTimes(2);
    });

    it("a failed create is NOT cached — the retry re-runs the handler", async () => {
        prisma.jobRequisition.findFirst.mockRejectedValueOnce(new Error("db down"));

        const res1 = await runOnce(mockReq({ key: "fail-1" }), async (res) => {
            try {
                await createApplication({ candidateId: 11, jobRequisitionId: 7, tenantId: "t-1" });
                res.status(201).json({ success: true });
            } catch {
                // error mapping, as the route's error middleware would produce
                res.status(500).json({ success: false });
            }
        });
        expect(res1.statusCode).toBe(500);

        // Retry with the SAME key: the failure was not cached, the handler runs.
        const res2 = await runOnce(mockReq({ key: "fail-1" }), appHandler);
        expect(res2.statusCode).toBe(201);
        expect(prisma.application.create).toHaveBeenCalledTimes(1);
    });
});
