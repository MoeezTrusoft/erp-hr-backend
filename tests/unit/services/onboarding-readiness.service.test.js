// Recruitment Phase 4 (stream M) — the day-one readiness job and its reads:
// the tenant-local window, the stored verdict and gaps, one alert per local
// day with HR owner and manager routing, per-row isolation, the flag, the
// tenant scope of every query (a lazy query outside the context fails), and
// the get / list views.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { makeOnsiteDb, eventRecorder } from "./helpers/onsite-test.fake.js";

const db = makeOnsiteDb();
const recorder = eventRecorder();
const SETTINGS = new Map();
const getRecruitmentSettings = jest.fn(async ({ tenantId }) => SETTINGS.get(tenantId) ?? { onboardingReadinessLeadDays: 2, timeZone: "Asia/Karachi" });

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent: recorder.enqueueHrDomainEvent,
    default: recorder.enqueueHrDomainEvent,
}));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const svc = await import("../../../src/services/onboarding-readiness.service.js");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
// 07:00 in Karachi on 20 Oct.
const NOW = new Date("2026-10-20T02:00:00.000Z");
const NEXT_DAY = new Date("2026-10-21T02:00:00.000Z");
const day = (d) => new Date(`2026-10-${d}T00:00:00.000Z`);
const atRisk = () => recorder.events.filter((e) => e.eventName === "hr.onboarding.readiness_at_risk.v1");

function seed() {
    db.state.tables = {};
    db.state.ops.length = 0;
    recorder.events.length = 0;
    SETTINGS.clear();
    SETTINGS.set(B, { onboardingReadinessLeadDays: 5, timeZone: "UTC" });
    const t = db.state.tables;
    t.employee = [
        { id: 1, tenant_id: A, first_name: "Ayesha", last_name: "Khan", managerId: 50 },
        { id: 2, tenant_id: A, first_name: "Bilal", last_name: "Raza", managerId: null },
        { id: 3, tenant_id: A, employee_name: "Late Starter", managerId: 51 },
        { id: 7, tenant_id: B, first_name: "Omar", last_name: "Ali", managerId: 70 },
    ];
    const checklist = (over) => ({
        status: "NOT_STARTED", memberAssignments: [], readinessStatus: null, readinessCheckedAt: null,
        readinessGaps: null, readinessAlertedAt: null, ...over,
    });
    t.onboardingChecklist = [
        checklist({ id: 100, tenantId: A, employeeId: 1, startDate: day(22), memberAssignments: [{ employeeId: 60, role: "HR", name: "x" }] }),
        checklist({ id: 101, tenantId: A, employeeId: 2, startDate: day(21), status: "IN_PROGRESS" }),
        checklist({ id: 102, tenantId: A, employeeId: 3, startDate: day(25) }),
        checklist({ id: 103, tenantId: A, employeeId: 3, startDate: day(21), status: "COMPLETED" }),
        checklist({ id: 200, tenantId: B, employeeId: 7, startDate: day(25) }),
    ];
    t.onboardingTask = [
        { id: 1000, tenantId: A, checklistId: 100, title: "Collect CNIC", stage: "pre_joining", completed: false, assigneeType: "HR", assigneeId: 61, sortOrder: 0 },
        { id: 1001, tenantId: A, checklistId: 100, title: "Team lunch", stage: "first_week", completed: false, assigneeType: "MANAGER", sortOrder: 1 },
        { id: 1010, tenantId: A, checklistId: 101, title: "Welcome pack", stage: "pre_boarding", completed: true, assigneeType: "HR", sortOrder: 0 },
        { id: 2000, tenantId: B, checklistId: 200, title: "Bank form", stage: "pre_boarding", completed: false, assigneeType: "HR", assigneeId: 71, sortOrder: 0 },
    ];
    t.onboardingProvisioningRequest = [
        { id: 1100, tenantId: A, checklistId: 100, title: "Laptop", status: "REQUESTED" },
        { id: 1110, tenantId: A, checklistId: 101, title: "Email", status: "FULFILLED" },
    ];
    t.onboardingDocument = [
        { id: 1200, tenantId: A, checklistId: 100, title: "Contract", requiresSign: true, signedAt: null, reviewStatus: null },
        { id: 1201, tenantId: A, checklistId: 100, title: "Degree", requiresSign: false, signedAt: null, reviewStatus: "PENDING" },
        { id: 1210, tenantId: A, checklistId: 101, title: "Policy", requiresSign: true, signedAt: day(19), reviewStatus: "VERIFIED" },
    ];
    t.onboardingSession = [
        { id: 1300, tenantId: A, checklistId: 100, title: "Orientation", required: true, sessionDate: null },
        { id: 1310, tenantId: A, checklistId: 101, title: "Orientation", required: true, sessionDate: day(21) },
    ];
}

const checklistRow = (id) => db.state.tables.onboardingChecklist.find((c) => c.id === id);

beforeEach(() => {
    process.env.HR_ONBOARDING_AUTOMATION = "true";
    seed();
});

describe("runOnboardingReadinessJob", () => {
    it("is off with the flag", async () => {
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        expect(await svc.runOnboardingReadinessJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(db.state.ops).toHaveLength(0);
    });

    it("checks open starts in each tenant's window, stores the verdict and alerts once", async () => {
        const summary = await svc.runOnboardingReadinessJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 4, ready: 1, atRisk: 2, alerted: 2, outOfWindow: 1, failed: 0 });

        const c100 = checklistRow(100);
        expect(c100.readinessStatus).toBe("AT_RISK");
        expect(c100.readinessCheckedAt).toEqual(NOW);
        expect(c100.readinessAlertedAt).toEqual(NOW);
        expect(c100.readinessGaps.map((g) => `${g.kind}:${g.id}`)).toEqual([
            "TASK:1000", "PROVISIONING:1100", "SIGNATURE:1200", "UPLOAD_REVIEW:1201", "SESSION:1300",
        ]);
        expect(checklistRow(101)).toMatchObject({ readinessStatus: "READY", readinessAlertedAt: null, readinessGaps: [] });
        // Starts in 5 days: outside tenant A's 2-day lead, never touched.
        expect(checklistRow(102).readinessStatus).toBeNull();
        expect(checklistRow(103).readinessStatus).toBeNull();
        // Tenant B's lead is 5 days.
        expect(checklistRow(200).readinessStatus).toBe("AT_RISK");

        const [first, second] = atRisk();
        expect(first).toEqual({
            eventName: "hr.onboarding.readiness_at_risk.v1",
            tenantId: A,
            aggregateType: "OnboardingChecklist",
            aggregateId: 100,
            actorId: null,
            payload: {
                checklistId: "100",
                employeeId: "1",
                startDate: "2026-10-22",
                daysUntilStart: 2,
                totalGaps: 5,
                gapCounts: { tasks: 1, provisioning: 1, signatures: 1, uploads: 1, sessions: 1 },
                hrOwnerId: "60",
                managerId: "50",
            },
        });
        // No HR member on the team: the HR task's assignee is the owner.
        expect(second.payload).toMatchObject({ checklistId: "200", hrOwnerId: "71", managerId: "70", daysUntilStart: 5 });
        expect(JSON.stringify(recorder.events)).not.toMatch(/Ayesha|Contract|Laptop/);
    });

    it("a second pass the same local day recomputes and does not re-alert; the next day does", async () => {
        await svc.runOnboardingReadinessJob({ now: NOW });
        const again = await svc.runOnboardingReadinessJob({ now: new Date(NOW.getTime() + 3 * 3600_000) });
        expect(again).toMatchObject({ atRisk: 2, alerted: 0 });
        expect(atRisk()).toHaveLength(2);

        // Fix everything on 100: it turns READY and keeps its last alert time.
        const t = db.state.tables;
        t.onboardingTask.find((x) => x.id === 1000).completed = true;
        t.onboardingProvisioningRequest.find((x) => x.id === 1100).status = "FULFILLED";
        t.onboardingDocument.find((x) => x.id === 1200).signedAt = NOW;
        t.onboardingDocument.find((x) => x.id === 1201).reviewStatus = "VERIFIED";
        t.onboardingSession.find((x) => x.id === 1300).sessionDate = day(22);
        const next = await svc.runOnboardingReadinessJob({ now: NEXT_DAY });
        expect(checklistRow(100).readinessStatus).toBe("READY");
        expect(checklistRow(100).readinessAlertedAt).toEqual(NOW);
        // 200 is still at risk on a new day: alerted again.
        expect(next.alerted).toBe(1);
        expect(atRisk()).toHaveLength(3);
        expect(checklistRow(200).readinessAlertedAt).toEqual(NEXT_DAY);
    });

    it("runs the scan as SYSTEM and every per-checklist query under its own tenant", async () => {
        await svc.runOnboardingReadinessJob({ now: NOW });
        const ops = db.state.ops;
        expect(ops[0]).toMatchObject({ model: "onboardingChecklist", op: "findMany", tenant: "SYSTEM" });
        expect(ops.slice(1).every((o) => o.tenant === A || o.tenant === B)).toBe(true);
        expect(ops.filter((o) => o.model === "onboardingTask").every((o) => o.tx)).toBe(true);
    });

    it("one failing checklist does not stop the others", async () => {
        const original = db.onboardingProvisioningRequest;
        db.onboardingProvisioningRequest = {
            ...original,
            findMany: (args) => (args.where.checklistId === 100 ? Promise.reject(new Error("boom")) : original.findMany(args)),
        };
        try {
            const summary = await svc.runOnboardingReadinessJob({ now: NOW });
            expect(summary).toMatchObject({ failed: 1, ready: 1, alerted: 1 });
            expect(checklistRow(100).readinessStatus).toBeNull();
        } finally {
            db.onboardingProvisioningRequest = original;
        }
    });

    it("a tenant whose settings cannot be read is skipped, the others run", async () => {
        getRecruitmentSettings.mockImplementationOnce(async () => {
            throw new Error("settings down");
        });
        const summary = await svc.runOnboardingReadinessJob({ now: NOW });
        expect(summary.failed).toBe(3);
        expect(checklistRow(200).readinessStatus).toBe("AT_RISK");
    });
});

describe("hr_onboarding_readiness_get / _list services", () => {
    const asA = (fn) => mcpCtx.run({ user: { tenantId: A } }, async () => await fn());

    it("get returns the live computation beside the stored verdict", async () => {
        const before = await asA(() => svc.getOnboardingReadiness({ tenantId: A, checklistId: 100, now: NOW }));
        expect(before).toMatchObject({
            checklistId: 100, employeeId: 1, startDate: "2026-10-22", daysUntilStart: 2, leadDays: 2, inWindow: true,
            live: { status: "AT_RISK", totalGaps: 5, hrOwnerId: 60, managerId: 50 },
            stored: { status: null, checkedAt: null, gaps: [] },
        });
        expect(before.live.gaps).toHaveLength(5);
        await svc.runOnboardingReadinessJob({ now: NOW });
        const after = await asA(() => svc.getOnboardingReadiness({ tenantId: A, checklistId: 100, now: NOW }));
        expect(after.stored).toMatchObject({ status: "AT_RISK", checkedAt: NOW, alertedAt: NOW });
    });

    it("get lists the hire's 30/60/90 surveys without their responses", async () => {
        db.state.tables.onboardingSurvey = [
            { id: 900, tenantId: A, checklistId: 100, employeeId: 1, type: "DAY_30", issuedAt: NOW, dueAt: NOW, remindedAt: null, submittedAt: null, responses: { q1: 5 } },
            { id: 901, tenantId: A, checklistId: 999, employeeId: 2, type: "DAY_30", issuedAt: NOW, dueAt: NOW, remindedAt: null, submittedAt: null },
        ];
        const out = await asA(() => svc.getOnboardingReadiness({ tenantId: A, checklistId: 100, now: NOW }));
        expect(out.surveys).toEqual([{ id: 900, type: "DAY_30", issuedAt: NOW, dueAt: NOW, remindedAt: null, submittedAt: null }]);
    });

    it("get is tenant-scoped and flag-gated", async () => {
        await expect(asA(() => svc.getOnboardingReadiness({ tenantId: A, checklistId: 200, now: NOW }))).rejects.toMatchObject({
            status: 404, code: "HR-ONBOARDING-NOT-FOUND",
        });
        process.env.HR_ONBOARDING_AUTOMATION = "false";
        await expect(asA(() => svc.getOnboardingReadiness({ tenantId: A, checklistId: 100, now: NOW }))).rejects.toMatchObject({
            status: 503, code: "HR-ONBOARDING-AUTOMATION-DISABLED",
        });
    });

    it("list shows upcoming open starts soonest first, with filters", async () => {
        await svc.runOnboardingReadinessJob({ now: NOW });
        const list = await asA(() => svc.listOnboardingReadiness({ tenantId: A, now: NOW }));
        expect(list).toMatchObject({ leadDays: 2, days: 2, total: 2 });
        expect(list.items.map((i) => [i.checklistId, i.readinessStatus, i.daysUntilStart])).toEqual([
            [101, "READY", 1],
            [100, "AT_RISK", 2],
        ]);
        expect(list.items[1]).toMatchObject({ employeeName: "Ayesha Khan", managerId: 50, gapCount: 5 });

        const wide = await asA(() => svc.listOnboardingReadiness({ tenantId: A, days: 7, status: "UNCHECKED", now: NOW }));
        expect(wide.items.map((i) => i.checklistId)).toEqual([102]);
        const risky = await asA(() => svc.listOnboardingReadiness({ tenantId: A, status: "AT_RISK", now: NOW }));
        expect(risky.items.map((i) => i.checklistId)).toEqual([100]);
        await expect(asA(() => svc.listOnboardingReadiness({ tenantId: A, status: "BAD", now: NOW }))).rejects.toMatchObject({ status: 400 });
    });
});
