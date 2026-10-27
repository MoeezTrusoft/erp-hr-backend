// Recruitment Phase 7 (C12) — retention:
//   (a) hr_candidate_retention_policy_get reads the stored policy per
//       population, or the default the run uses (no clock) flagged isDefault,
//       with the same permission as the policy set tool;
//   (b) a manual hr_candidate_retention_apply is recorded as a
//       CandidateRetentionRun through the job's recording path: APPLY signed
//       off by the caller when it erased, DRY_RUN (with its report) otherwise,
//       FAILED and rethrown on an error, and what applyRetention decides is
//       untouched (same arguments, same result back, plus the run id).
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createPrivacyFake } from "./helpers/privacy-operations.fake.js";

let db = createPrivacyFake();
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
const applyRetention = jest.fn();
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ applyRetention }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const svc = await import("../../../src/services/retention-run.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T02:00:00.000Z");
const CALLER = 42;
const ORG = resolveRecruitmentScope({ roles: ["HR_ADMIN"] });
const asTenant = (fn) => mcpCtx.run({ user: { tenantId: TENANT, employeeId: CALLER } }, fn);
const settingsRow = (over = {}) => ({ tenantId: TENANT, dataPolicyOwnerId: 7, retentionApplyEnabled: true, version: 3, ...over });
const manual = (over = {}) => asTenant(() => svc.runManualRetention({ tenantId: TENANT, actorId: CALLER, asOf: NOW, limit: 100, ...over }));

beforeEach(() => {
    db = createPrivacyFake();
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_RETENTION_AUTOMATION;
});

describe("C12b: a manual apply is recorded like the nightly run", () => {
    it("an APPLY that erased is recorded APPLY, signed off by the caller, and shows on the runs list", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        const result = { dryRun: false, asOf: NOW, anonymized: [3, 4], suspendedByLegalHold: [{ id: 5, legalHoldId: 9 }] };
        applyRetention.mockResolvedValue(result);

        const out = await manual({ dryRun: false });

        // What gets anonymised is applyRetention's decision, asked exactly as before.
        expect(applyRetention).toHaveBeenCalledTimes(1);
        expect(applyRetention).toHaveBeenCalledWith({ tenantId: TENANT, asOf: NOW, actorId: CALLER, dryRun: false, limit: 100 });
        const [run] = db.rows("candidateRetentionRun");
        expect(run).toMatchObject({ tenantId: TENANT, mode: "APPLY", status: "COMPLETED", anonymized: 2, wouldAnonymize: 0, suspendedByLegalHold: 1, signedOffById: CALLER });
        expect(run.signedOffAt).toBeInstanceOf(Date);
        expect(out).toEqual({ ...result, runId: run.id, runMode: "APPLY" });
        // No dry-run report for an apply.
        expect(db.rows("outboxEvent")).toHaveLength(0);

        const listed = await asTenant(() => svc.listRetentionRuns({ tenantId: TENANT, scope: ORG }));
        expect(listed.items.map((r) => r.id)).toEqual([run.id]);
        expect(listed.items[0]).toMatchObject({ mode: "APPLY", signedOffById: CALLER });
    });

    it("a dry run is recorded DRY_RUN, unsigned (still open for the owner's sign-off), with its report sent", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: false }));
        applyRetention.mockResolvedValue({ dryRun: true, asOf: NOW, wouldAnonymize: [3], suspendedByLegalHold: [] });

        const out = await manual({ dryRun: true });

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
        const [run] = db.rows("candidateRetentionRun");
        expect(run).toMatchObject({ mode: "DRY_RUN", status: "COMPLETED", wouldAnonymize: 1 });
        expect(run.signedOffById ?? null).toBeNull();
        expect(run.signedOffAt ?? null).toBeNull();
        expect(run.reportSentAt).toBeInstanceOf(Date);
        expect(db.rows("outboxEvent")[0].eventName).toBe("hr.recruitment.retention_dry_run_report.v1");
        expect(out).toMatchObject({ dryRun: true, wouldAnonymize: [3], runId: run.id, runMode: "DRY_RUN" });
    });

    it("an apply the service refused keeps its refusal answer and is recorded as the dry-run it became", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: false }));
        const refused = { dryRun: true, refused: true, reason: "tenant-not-signed-off", asOf: NOW, wouldAnonymize: [8], suspendedByLegalHold: [] };
        applyRetention.mockResolvedValue(refused);

        const out = await manual({ dryRun: false });

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
        expect(out).toMatchObject({ ...refused, runMode: "DRY_RUN" });
        const [run] = db.rows("candidateRetentionRun");
        expect(run).toMatchObject({ mode: "DRY_RUN", wouldAnonymize: 1 });
        expect(run.candidateIds.refusedReason).toBe("tenant-not-signed-off");
        expect(run.signedOffById ?? null).toBeNull();
    });

    it("a failure is recorded FAILED (intended mode, signed by the caller for an apply) and rethrown", async () => {
        applyRetention.mockRejectedValue(new Error("DB blip"));

        await expect(manual({ dryRun: false })).rejects.toThrow("DB blip");

        const [run] = db.rows("candidateRetentionRun");
        expect(run).toMatchObject({ mode: "APPLY", status: "FAILED", error: "DB blip", anonymized: 0, signedOffById: CALLER });
    });

    it("dryRun defaults to true", async () => {
        applyRetention.mockResolvedValue({ dryRun: true, wouldAnonymize: [], suspendedByLegalHold: [] });
        await manual({ dryRun: undefined });
        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    });

    it("a run row that cannot be written never hides an erasure that happened", async () => {
        applyRetention.mockResolvedValue({ dryRun: false, anonymized: [3], suspendedByLegalHold: [] });
        db.candidateRetentionRun.create = () => Promise.reject(new Error("insert failed"));

        const out = await manual({ dryRun: false });

        expect(out).toMatchObject({ dryRun: false, anonymized: [3], runId: null, runMode: null });
    });

    it("runs every query under the caller's tenant", async () => {
        applyRetention.mockResolvedValue({ dryRun: true, wouldAnonymize: [], suspendedByLegalHold: [] });
        await manual();
        expect(db.contextLog.length).toBeGreaterThan(0);
        expect(db.contextLog.every((entry) => entry.tenantId === TENANT && !entry.system)).toBe(true);
    });

    it("needs the tenant", async () => {
        await expect(svc.runManualRetention({ dryRun: false })).rejects.toMatchObject({ code: "HR-TENANT-REQUIRED" });
        expect(applyRetention).not.toHaveBeenCalled();
    });
});
