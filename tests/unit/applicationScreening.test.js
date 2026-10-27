// tests/unit/applicationScreening.test.js
//
// Phase 6 / decision record §4.1–4.3 — the screening record, the reason-code
// taxonomy and the shortlist:
//
//   * §4.1  the decision is first-class: outcome + reason code + notes +
//           optional criteria, appended (a re-screen is a new row)
//   * §4.1b an ADVANCE screening is required before the interview STAGE move
//   * §4.2  REJECT/HOLD demand an ACTIVE tenant code; OTHER demands notes;
//           the default taxonomy is seeded lazily, once, concurrently-safe
//   * §4.3  the shortlist is one row per application, idempotent to re-add,
//           and its removal leaves the disposition record as the audit of WHY

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
    application: { findFirst: jest.fn(), update: jest.fn() },
    applicationStageHistory: { create: jest.fn() },
    interview: { findFirst: jest.fn() },
    jobRequisition: { findFirst: jest.fn() },
    applicationScreening: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    dispositionReasonCode: {
        findMany: jest.fn(),
        createMany: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
    },
    shortlistEntry: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
    // FR-07 residue — the screening scorecard template lookup. Default: no
    // template linked, so criteria stay free-form (the pre-residue behavior).
    scorecardTemplateLink: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(),
};
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: (client, fn) => fn(client),
}));

const { DEFAULT_DISPOSITION_REASONS, validateScreeningDecision, validateCriteria, SCREENING_OUTCOMES } = await import(
    "../../src/lib/dispositionReasons.js"
);
const service = await import("../../src/services/application-screening.service.js");
const workflow = await import("../../src/services/application-workflow.service.js");

const defaultCodes = DEFAULT_DISPOSITION_REASONS.map((r) => ({ code: r.code, requiresNotes: r.requiresNotes, version: 1 }));

const seedCodes = () => {
    // First findMany: no codes yet → seed; second findMany: the seeded set.
    prisma.dispositionReasonCode.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValue(defaultCodes);
    prisma.dispositionReasonCode.createMany.mockResolvedValue({ count: defaultCodes.length });
};

const seedApplication = (overrides = {}) => {
    prisma.application.findFirst.mockResolvedValue({ id: 900, stage: "screening", tenantId: "t-1", jobRequisitionId: 42, ...overrides });
};

// Silence the workflow service's shared imports on the gate tests.
logAction.mockResolvedValue(undefined);

// ── §4.1 — the screening record ──────────────────────────────────────────────
describe("screening.recordScreening (§4.1)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        logAction.mockResolvedValue(undefined);
        prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    });

    it("records an ADVANCE with no reason code and stores criteria", async () => {
        seedApplication();
        prisma.dispositionReasonCode.findMany.mockResolvedValue(defaultCodes);
        prisma.applicationScreening.create.mockResolvedValue({ id: 1, outcome: "ADVANCE" });

        const row = await service.recordScreening({
            applicationId: 900,
            tenantId: "t-1",
            outcome: "ADVANCE",
            criteria: [{ criterion: "Years of experience", result: "PASS" }],
            actorId: 7,
        });

        expect(row.outcome).toBe("ADVANCE");
        expect(prisma.applicationScreening.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                applicationId: 900,
                outcome: "ADVANCE",
                reasonCode: null,
                criteria: [{ criterion: "Years of experience", result: "PASS" }],
                reviewedById: 7,
            }),
        });
    });

    it("records a REJECT with an active code and normalizes notes", async () => {
        seedApplication();
        prisma.dispositionReasonCode.findMany.mockResolvedValue(defaultCodes);
        prisma.applicationScreening.create.mockResolvedValue({ id: 2, outcome: "REJECT" });

        await service.recordScreening({
            applicationId: 900,
            tenantId: "t-1",
            outcome: "REJECT",
            reasonCode: "SKILLS_MISMATCH",
            notes: "  Missing the platform depth the panel wanted  ",
        });

        expect(prisma.applicationScreening.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                outcome: "REJECT",
                reasonCode: "SKILLS_MISMATCH",
                notes: "Missing the platform depth the panel wanted",
            }),
        });
    });

    it("refuses a REJECT without a reason code and an ADVANCE with one", async () => {
        seedApplication();
        prisma.dispositionReasonCode.findMany.mockResolvedValue(defaultCodes);

        await expect(
            service.recordScreening({ applicationId: 900, tenantId: "t-1", outcome: "REJECT" }),
        ).rejects.toMatchObject({ status: 400 });

        seedApplication();
        await expect(
            service.recordScreening({ applicationId: 900, tenantId: "t-1", outcome: "ADVANCE", reasonCode: "OTHER" }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("refuses a code that is not active for the tenant", async () => {
        seedApplication();
        prisma.dispositionReasonCode.findMany.mockResolvedValue(defaultCodes);

        await expect(
            service.recordScreening({ applicationId: 900, tenantId: "t-1", outcome: "REJECT", reasonCode: "MADE_UP" }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("demands notes for OTHER (§4.2) and accepts them once present", async () => {
        seedApplication();
        prisma.dispositionReasonCode.findMany.mockResolvedValue(defaultCodes);

        await expect(
            service.recordScreening({ applicationId: 900, tenantId: "t-1", outcome: "REJECT", reasonCode: "OTHER" }),
        ).rejects.toMatchObject({ status: 400 });

        seedApplication();
        prisma.applicationScreening.create.mockResolvedValue({ id: 3 });
        await service.recordScreening({
            applicationId: 900, tenantId: "t-1", outcome: "REJECT", reasonCode: "OTHER", notes: "Client mandated a security clearance the candidate declined.",
        });
        expect(prisma.applicationScreening.create).toHaveBeenCalled();
    });

    it("seeds the default taxonomy on a fresh tenant inside the same transaction", async () => {
        seedApplication();
        prisma.dispositionReasonCode.findMany
            .mockResolvedValueOnce([]) // nothing yet
            .mockResolvedValue(defaultCodes); // after seeding
        prisma.dispositionReasonCode.createMany.mockResolvedValue({ count: defaultCodes.length });
        prisma.applicationScreening.create.mockResolvedValue({ id: 4 });

        await service.recordScreening({
            applicationId: 900, tenantId: "fresh-tenant", outcome: "REJECT", reasonCode: "EXPERIENCE_MISMATCH",
        });

        expect(prisma.dispositionReasonCode.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([
                expect.objectContaining({ tenantId: "fresh-tenant", code: "OTHER", requiresNotes: true }),
            ]),
        });
    });

    it("refuses a cross-tenant application with 404 (no existence oracle)", async () => {
        prisma.application.findFirst.mockResolvedValue(null);
        await expect(
            service.recordScreening({ applicationId: 900, tenantId: "other", outcome: "ADVANCE" }),
        ).rejects.toMatchObject({ status: 404 });
    });
});

// ── §4.1b — the gate ─────────────────────────────────────────────────────────
describe("screening ADVANCE gate before interview (§4.1b)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        logAction.mockResolvedValue(undefined);
    });

    it("refuses the screening → interview stage move without a recorded ADVANCE", async () => {
        prisma.application.findFirst.mockResolvedValue({
            id: 900, stage: "screening", tenantId: "t-1", jobRequisitionId: 42,
        });
        prisma.applicationScreening.findFirst.mockResolvedValue(null); // no ADVANCE on file

        await expect(
            workflow.transitionApplicationStage({ id: 900, tenantId: "t-1", targetStage: "interview", actorId: 7 }),
        ).rejects.toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-SCREENING-ADVANCE-REQUIRED",
        });
    });

    it("allows the move once an ADVANCE exists (with the interview scheduled)", async () => {
        prisma.application.findFirst.mockResolvedValue({
            id: 900, stage: "screening", tenantId: "t-1", jobRequisitionId: 42,
        });
        prisma.applicationScreening.findFirst.mockResolvedValue({ id: 77 });
        prisma.interview.findFirst.mockResolvedValue({ id: 55 });
        prisma.application.update.mockResolvedValue({ id: 900, stage: "interview" });
        prisma.applicationStageHistory.create.mockResolvedValue({});

        const result = await workflow.transitionApplicationStage({
            id: 900, tenantId: "t-1", targetStage: "interview", actorId: 7,
        });

        expect(result.changed).toBe(true);
    });

    it("does not gate stage moves that are not the interview move", async () => {
        prisma.application.findFirst.mockResolvedValue({
            id: 900, stage: "applied", tenantId: "t-1", jobRequisitionId: 42,
        });
        prisma.application.update.mockResolvedValue({ id: 900, stage: "screening" });
        prisma.applicationStageHistory.create.mockResolvedValue({});

        const result = await workflow.transitionApplicationStage({
            id: 900, tenantId: "t-1", targetStage: "screening", actorId: 7,
        });
        expect(result.changed).toBe(true);
        expect(prisma.applicationScreening.findFirst).not.toHaveBeenCalled();
    });
});

// ── §4.2 — reason codes ──────────────────────────────────────────────────────
describe("disposition reason codes (§4.2)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    });

    it("exposes the default taxonomy from the decision record verbatim", () => {
        const codes = DEFAULT_DISPOSITION_REASONS.map((r) => r.code);
        for (const expected of [
            "MINIMUM_REQUIREMENTS_NOT_MET", "EXPERIENCE_MISMATCH", "SKILLS_MISMATCH", "COMPENSATION_MISMATCH",
            "AVAILABILITY_MISMATCH", "POSITION_FILLED", "REQUISITION_CLOSED", "CANDIDATE_WITHDREW",
            "UNABLE_TO_CONTACT", "DUPLICATE_APPLICATION", "OTHER",
        ]) {
            expect(codes).toContain(expected);
        }
        expect(DEFAULT_DISPOSITION_REASONS.find((r) => r.code === "OTHER").requiresNotes).toBe(true);
    });

    it("versions a code instead of editing it, and skips a no-op version", async () => {
        prisma.dispositionReasonCode.findFirst.mockResolvedValue({ code: "OTHER", label: "Other", requiresNotes: true, version: 3 });

        prisma.dispositionReasonCode.create.mockResolvedValue({ code: "OTHER", label: "Other reason", requiresNotes: true, version: 4 });
        await service.versionDispositionReason({ tenantId: "t-1", code: "OTHER", label: "Other reason", requiresNotes: true });
        expect(prisma.dispositionReasonCode.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ code: "OTHER", label: "Other reason", version: 4 }),
        });

        // Same shape → returns the current row, no new version.
        jest.clearAllMocks();
        prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
        prisma.dispositionReasonCode.findFirst.mockResolvedValue({ code: "OTHER", label: "Other", requiresNotes: true, version: 3 });
        const same = await service.versionDispositionReason({ tenantId: "t-1", code: "OTHER", label: "Other", requiresNotes: true });
        expect(prisma.dispositionReasonCode.create).not.toHaveBeenCalled();
        expect(same.version).toBe(3);
    });

    it("deactivates by code across versions and 404s an unknown code", async () => {
        prisma.dispositionReasonCode.updateMany.mockResolvedValue({ count: 2 });
        expect(await service.deactivateDispositionReason("t-1", "OTHER")).toEqual({ code: "OTHER", deactivated: true });

        prisma.dispositionReasonCode.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.deactivateDispositionReason("t-1", "GHOST")).rejects.toMatchObject({ status: 404 });
    });
});

// ── §4.3 — the shortlist ─────────────────────────────────────────────────────
describe("shortlist (§4.3)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    });

    it("adds an application with its requisition resolved from the row", async () => {
        seedApplication();
        prisma.shortlistEntry.findUnique.mockResolvedValue(null);
        prisma.shortlistEntry.create.mockResolvedValue({ id: 9, applicationId: 900, requisitionId: 42 });

        const row = await service.addToShortlist({ applicationId: 900, tenantId: "t-1", note: "Strong signal", actorId: 7 });

        expect(prisma.shortlistEntry.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ applicationId: 900, requisitionId: 42, tenantId: "t-1", addedById: 7 }),
        });
        expect(row.id).toBe(9);
    });

    it("is idempotent: a repeat add refreshes the note, not a duplicate row", async () => {
        seedApplication();
        prisma.shortlistEntry.findUnique.mockResolvedValue({ id: 9, applicationId: 900, note: null });
        prisma.shortlistEntry.update.mockResolvedValue({ id: 9, applicationId: 900, note: "updated" });

        await service.addToShortlist({ applicationId: 900, tenantId: "t-1", note: "updated" });
        expect(prisma.shortlistEntry.create).not.toHaveBeenCalled();
        expect(prisma.shortlistEntry.update).toHaveBeenCalledWith({
            where: { applicationId: 900 },
            data: { note: "updated" },
        });

        // No new note → returns the existing row flagged.
        jest.clearAllMocks();
        prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
        seedApplication();
        prisma.shortlistEntry.findUnique.mockResolvedValue({ id: 9, applicationId: 900, note: null });
        const res = await service.addToShortlist({ applicationId: 900, tenantId: "t-1" });
        expect(res.alreadyListed).toBe(true);
    });

    it("removal 404s when the application was never listed", async () => {
        prisma.shortlistEntry.deleteMany.mockResolvedValue({ count: 0 });
        await expect(service.removeFromShortlist({ applicationId: 900, tenantId: "t-1" })).rejects.toMatchObject({
            status: 404,
        });
    });

    it("lists a requisition's shortlist with candidate identity for the hiring team", async () => {
        prisma.shortlistEntry.findMany.mockResolvedValue([
            { id: 9, applicationId: 900, application: { id: 900, stage: "screening", candidate: { id: 5, firstName: "Ayesha", lastName: "Malik" } } },
        ]);
        const rows = await service.listShortlist(42, "t-1");
        expect(rows[0].application.candidate.firstName).toBe("Ayesha");
        expect(prisma.shortlistEntry.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { requisitionId: 42, tenantId: "t-1" } }),
        );
    });
});

// ── pure validation edges ────────────────────────────────────────────────────
describe("dispositionReasons pure validation", () => {
    it("caps and validates criteria entries", () => {
        expect(validateCriteria("nope").ok).toBe(false);
        expect(validateCriteria([{ criterion: "", result: "PASS" }]).ok).toBe(false);
        expect(validateCriteria([{ criterion: "x", result: "MAYBE" }]).ok).toBe(false);
        expect(validateCriteria([{ criterion: "x", result: "pass" }]).normalized[0].result).toBe("PASS");
        expect(validateCriteria(null).ok).toBe(true);
    });

    it("rejects unknown outcomes before consulting codes", () => {
        const r = validateScreeningDecision({ outcome: "MAYBE", reasonCode: null, notes: null, activeCodes: defaultCodes });
        expect(r.ok).toBe(false);
        expect(r.errors.join(" ")).toMatch(/outcome must be one of/);
        expect(SCREENING_OUTCOMES).toEqual(["ADVANCE", "REJECT", "HOLD"]);
    });
});
