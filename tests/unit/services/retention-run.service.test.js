// Recruitment Phase 5 (plan 6.9) — retention runs per tenant and the
// data-policy owner's sign-off.
//
// What is defended here:
//   * every run is recorded (DRY_RUN, APPLY or FAILED) with counts, a capped
//     id list and the legal-hold suspensions, and every completed dry-run
//     sends its report to the owner (event + reportSentAt);
//   * a tenant APPLIES only when the env mode, the flag and its own switch all
//     say so;
//   * the switch turns on only through the owner's sign-off of a recent,
//     completed dry-run, and off at once;
//   * all of it under the tenant's own context, never another tenant's rows.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createPrivacyFake } from "./helpers/privacy-operations.fake.js";

let db = createPrivacyFake();
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prismaProxy }));
const applyRetention = jest.fn();
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ applyRetention }));
const logAction = jest.fn(async () => undefined);
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const svc = await import("../../../src/services/retention-run.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T02:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OWNER = 42;
const ORG = resolveRecruitmentScope({ roles: ["HR_ADMIN"] });
const owner = { employeeId: OWNER, roles: ["HR_ADMIN"], isAdmin: false, tenantId: TENANT };
const admin = { employeeId: 7, roles: ["HR_ADMIN"], isAdmin: true, tenantId: TENANT };

const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId } }, fn);

const dryRunRow = (over = {}) => ({
    id: 10,
    tenantId: TENANT,
    mode: "DRY_RUN",
    status: "COMPLETED",
    asOf: new Date(NOW.getTime() - DAY),
    wouldAnonymize: 2,
    anonymized: 0,
    suspendedByLegalHold: 1,
    candidateIds: { ids: [3, 4], held: [{ candidateId: 5, legalHoldId: 9 }], truncated: false },
    createdAt: new Date(NOW.getTime() - DAY),
    signedOffAt: null,
    signedOffById: null,
    ...over,
});

const settingsRow = (over = {}) => ({ tenantId: TENANT, dataPolicyOwnerId: OWNER, retentionApplyEnabled: false, version: 3, ...over });

beforeEach(() => {
    db = createPrivacyFake();
    jest.clearAllMocks();
    delete process.env.HR_RECRUITMENT_RETENTION_AUTOMATION;
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_RETENTION_AUTOMATION;
});

describe("runTenantRetention", () => {
    it("records a dry-run with counts, ids and holds, and sends the report to the owner", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        applyRetention.mockResolvedValue({
            dryRun: true,
            wouldAnonymize: [3, 4],
            suspendedByLegalHold: [{ id: 5, email: "held@example.com", legalHoldId: 9 }],
        });

        const out = await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode: "dry-run", asOf: NOW }));

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, dryRun: true }));
        expect(out.reportSent).toBe(true);
        const [run] = db.rows("candidateRetentionRun");
        expect(run).toMatchObject({ tenantId: TENANT, mode: "DRY_RUN", status: "COMPLETED", wouldAnonymize: 2, anonymized: 0, suspendedByLegalHold: 1 });
        expect(run.candidateIds).toEqual({ ids: [3, 4], held: [{ candidateId: 5, legalHoldId: 9 }], truncated: false, limitReached: false });
        expect(run.reportSentAt).toBeInstanceOf(Date);
        // No address or other PII lands on the run row.
        expect(JSON.stringify(run)).not.toContain("held@example.com");

        const [event] = db.rows("outboxEvent");
        expect(event.eventName).toBe("hr.recruitment.retention_dry_run_report.v1");
        expect(event.payload.payload).toMatchObject({ runId: String(run.id), wouldAnonymize: 2, suspendedByLegalHold: 1, dataPolicyOwnerId: String(OWNER) });
        expect(db.contextLog.every((entry) => entry.tenantId === TENANT && !entry.system)).toBe(true);
    });

    it.each([
        ["the env mode is dry-run", "dry-run", "true", true],
        ["the flag is off", "apply", "false", true],
        ["the tenant has not switched apply on", "apply", "true", false],
    ])("dry-runs when %s", async (_label, envMode, flag, tenantOn) => {
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = flag;
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: tenantOn }));
        applyRetention.mockResolvedValue({ dryRun: true, wouldAnonymize: [], suspendedByLegalHold: [] });

        await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode, asOf: NOW }));

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
        expect(db.rows("candidateRetentionRun")[0].mode).toBe("DRY_RUN");
    });

    it("applies when the env mode, the flag and the tenant switch all agree, and sends no report", async () => {
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "true";
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: true }));
        applyRetention.mockResolvedValue({ dryRun: false, anonymized: [3], suspendedByLegalHold: [] });

        const out = await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode: "apply", asOf: NOW }));

        expect(applyRetention).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
        expect(out.run).toMatchObject({ mode: "APPLY", anonymized: 1, wouldAnonymize: 0 });
        expect(out.reportSent).toBe(false);
        expect(db.rows("outboxEvent")).toHaveLength(0);
    });

    it("records an apply the service refused as the dry-run it became, with the reason", async () => {
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "true";
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: true }));
        applyRetention.mockResolvedValue({ dryRun: true, refused: true, reason: "tenant-not-signed-off", wouldAnonymize: [8], suspendedByLegalHold: [] });

        await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode: "apply", asOf: NOW }));

        const [run] = db.rows("candidateRetentionRun");
        expect(run.mode).toBe("DRY_RUN");
        expect(run.candidateIds.refusedReason).toBe("tenant-not-signed-off");
    });

    it("records a failure as FAILED with the error, and sends no report", async () => {
        applyRetention.mockRejectedValue(new Error("DB blip"));

        const out = await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode: "dry-run", asOf: NOW }));

        expect(out.error.message).toBe("DB blip");
        expect(db.rows("candidateRetentionRun")[0]).toMatchObject({ status: "FAILED", error: "DB blip", wouldAnonymize: 0 });
        expect(db.rows("outboxEvent")).toHaveLength(0);
    });

    it("keeps the run when its report cannot be sent (reportSentAt stays null)", async () => {
        applyRetention.mockResolvedValue({ dryRun: true, wouldAnonymize: [3], suspendedByLegalHold: [] });
        db.outboxEvent.create = () => Promise.reject(new Error("outbox down"));

        const out = await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode: "dry-run", asOf: NOW }));

        expect(out.reportSent).toBe(false);
        expect(db.rows("candidateRetentionRun")[0]).toMatchObject({ mode: "DRY_RUN", status: "COMPLETED", wouldAnonymize: 1 });
        expect(db.rows("candidateRetentionRun")[0].reportSentAt ?? null).toBeNull();
    });

    it("caps the stored ids at 500 and keeps the exact count", async () => {
        const many = Array.from({ length: 620 }, (_, i) => i + 1);
        applyRetention.mockResolvedValue({ dryRun: true, wouldAnonymize: many, suspendedByLegalHold: [] });

        await asTenant(() => svc.runTenantRetention({ tenantId: TENANT, envMode: "dry-run", asOf: NOW }));

        const [run] = db.rows("candidateRetentionRun");
        expect(run.wouldAnonymize).toBe(620);
        expect(run.candidateIds.ids).toHaveLength(500);
        expect(run.candidateIds.truncated).toBe(true);
    });
});

describe("hr_candidate_retention_signoff", () => {
    beforeEach(() => {
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "true";
    });

    it("the owner signs off a recent completed dry-run: the run is stamped and apply is switched on", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        db.rows("candidateRetentionRun").push(dryRunRow());

        const out = await asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 10, expectedVersion: 3, now: NOW }));

        expect(out).toMatchObject({ runId: 10, signedOffById: OWNER, replayed: false });
        expect(db.rows("candidateRetentionRun")[0]).toMatchObject({ signedOffById: OWNER, signedOffAt: NOW });
        expect(db.rows("tenantRecruitmentSettings")[0]).toMatchObject({
            retentionApplyEnabled: true,
            retentionApplyEnabledAt: NOW,
            retentionApplyEnabledById: OWNER,
            retentionSignoffRunId: 10,
            version: 4,
        });
        expect(db.rows("outboxEvent")[0].eventName).toBe("hr.recruitment.retention_apply_changed.v1");
        expect(db.rows("outboxEvent")[0].payload.payload).toMatchObject({ enabled: true, runId: "10", actorId: String(OWNER) });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ employeeId: OWNER, tenantId: TENANT, module: "Candidate Retention" }));
    });

    it("replays when the same sign-off is already in force", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: true, retentionSignoffRunId: 10 }));
        db.rows("candidateRetentionRun").push(dryRunRow({ signedOffAt: NOW, signedOffById: OWNER }));

        const out = await asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 10, now: NOW }));

        expect(out.replayed).toBe(true);
        expect(db.rows("outboxEvent")).toHaveLength(0);
        expect(logAction).not.toHaveBeenCalled();
    });

    it.each([
        ["a FAILED run", { status: "FAILED" }, "HR-RECRUITMENT-RETENTION-RUN-FAILED"],
        ["a run older than 7 days", { createdAt: new Date(NOW.getTime() - 8 * DAY) }, "HR-RECRUITMENT-RETENTION-RUN-STALE"],
        ["an APPLY run", { mode: "APPLY" }, "HR-RECRUITMENT-RETENTION-RUN-NOT-DRY-RUN"],
        ["a run signed off before", { signedOffAt: new Date(NOW.getTime() - DAY), signedOffById: OWNER }, "HR-RECRUITMENT-RETENTION-RUN-ALREADY-SIGNED-OFF"],
    ])("refuses %s and leaves apply off", async (_label, over, code) => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        db.rows("candidateRetentionRun").push(dryRunRow(over));

        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 10, now: NOW })))
            .rejects.toMatchObject({ status: 409, code });
        expect(db.rows("tenantRecruitmentSettings")[0].retentionApplyEnabled).toBe(false);
    });

    it("only the owner may sign off once one is named, even an admin may not", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        db.rows("candidateRetentionRun").push(dryRunRow());

        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: admin, scope: ORG, runId: 10, now: NOW })))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-RETENTION-OWNER-REQUIRED" });
    });

    it("an admin signs off while no owner is set; a non-admin may not", async () => {
        db.rows("candidateRetentionRun").push(dryRunRow());

        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 10, now: NOW })))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-RETENTION-OWNER-REQUIRED" });
        const out = await asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: admin, scope: ORG, runId: 10, now: NOW }));
        expect(out.retention).toMatchObject({ retentionApplyEnabled: true, retentionSignoffRunId: 10, retentionApplyEnabledById: 7 });
    });

    it("refuses another tenant's run as not found, a stale settings version, a non-ORG scope and the flag off", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        db.rows("candidateRetentionRun").push(dryRunRow({ id: 11, tenantId: OTHER }));
        db.rows("candidateRetentionRun").push(dryRunRow());

        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 11, now: NOW })))
            .rejects.toMatchObject({ status: 404 });
        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 10, expectedVersion: 1, now: NOW })))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT" });
        const managed = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: OWNER });
        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: managed, runId: 10, now: NOW })))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-PRIVACY-FORBIDDEN" });
        process.env.HR_RECRUITMENT_RETENTION_AUTOMATION = "false";
        await expect(asTenant(() => svc.signOffRetentionRun({ tenantId: TENANT, user: owner, scope: ORG, runId: 10, now: NOW })))
            .rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-RETENTION-DISABLED" });
    });
});

describe("hr_candidate_retention_apply_disable", () => {
    it("switches apply off at once, audited; a second call changes nothing", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: true, retentionApplyEnabledAt: NOW, retentionApplyEnabledById: OWNER, retentionSignoffRunId: 10 }));

        const first = await asTenant(() => svc.disableRetentionApply({ tenantId: TENANT, user: owner, scope: ORG, reason: "policy review" }));
        const second = await asTenant(() => svc.disableRetentionApply({ tenantId: TENANT, user: owner, scope: ORG }));

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        expect(db.rows("tenantRecruitmentSettings")[0]).toMatchObject({ retentionApplyEnabled: false, retentionApplyEnabledAt: null, retentionSignoffRunId: 10 });
        expect(logAction).toHaveBeenCalledTimes(1);
        expect(logAction.mock.calls[0][0].notes).toContain("policy review");
        expect(db.rows("outboxEvent")[0].payload.payload).toMatchObject({ enabled: false });
    });

    it("is the owner's decision", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow({ retentionApplyEnabled: true }));
        await expect(asTenant(() => svc.disableRetentionApply({ tenantId: TENANT, user: { ...admin, employeeId: 99 }, scope: ORG })))
            .rejects.toMatchObject({ status: 403 });
    });
});

describe("hr_candidate_retention_owner_set", () => {
    it("an admin names an employee of the tenant; another tenant's employee is not found", async () => {
        db.rows("employee").push({ id: OWNER, tenant_id: TENANT }, { id: 77, tenant_id: OTHER });

        const out = await asTenant(() => svc.setDataPolicyOwner({ tenantId: TENANT, user: admin, scope: ORG, employeeId: OWNER }));
        expect(out).toMatchObject({ changed: true, retention: { dataPolicyOwnerId: OWNER, version: 1 } });

        await expect(asTenant(() => svc.setDataPolicyOwner({ tenantId: TENANT, user: admin, scope: ORG, employeeId: 77 })))
            .rejects.toMatchObject({ status: 404 });
        await expect(asTenant(() => svc.setDataPolicyOwner({ tenantId: TENANT, user: owner, scope: ORG, employeeId: OWNER })))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-RETENTION-ADMIN-REQUIRED" });
    });
});

describe("runs list and get", () => {
    it("lists newest first with the switch, and gets ids, holds and sign-off eligibility", async () => {
        db.rows("tenantRecruitmentSettings").push(settingsRow());
        db.rows("candidateRetentionRun").push(
            dryRunRow({ id: 10, createdAt: new Date(NOW.getTime() - 2 * DAY) }),
            dryRunRow({ id: 12, status: "FAILED", error: "boom", createdAt: new Date(NOW.getTime() - DAY) }),
            dryRunRow({ id: 13, tenantId: OTHER }),
        );

        const list = await asTenant(() => svc.listRetentionRuns({ tenantId: TENANT, scope: ORG }));
        expect(list.items.map((r) => r.id)).toEqual([12, 10]);
        expect(list.items[0].candidateIds).toBeUndefined();
        expect(list.retention).toMatchObject({ dataPolicyOwnerId: OWNER, retentionApplyEnabled: false });

        const run = await asTenant(() => svc.getRetentionRun({ tenantId: TENANT, scope: ORG, runId: 10, now: NOW }));
        expect(run).toMatchObject({ id: 10, candidateIds: [3, 4], legalHoldSuspensions: [{ candidateId: 5, legalHoldId: 9 }], signoff: { eligible: true, reason: null } });
        const failed = await asTenant(() => svc.getRetentionRun({ tenantId: TENANT, scope: ORG, runId: 12, now: NOW }));
        expect(failed.signoff).toMatchObject({ eligible: false, reason: "HR-RECRUITMENT-RETENTION-RUN-FAILED" });
        await expect(asTenant(() => svc.getRetentionRun({ tenantId: TENANT, scope: ORG, runId: 13, now: NOW }))).rejects.toMatchObject({ status: 404 });
    });
});
