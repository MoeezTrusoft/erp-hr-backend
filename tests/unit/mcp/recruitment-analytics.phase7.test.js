// tests/unit/mcp/recruitment-analytics.phase7.test.js
//
// Recruitment Phase 7 (D9, D10) — analytics:
//   * the export takes the dashboard's filters through the same builder and
//     the same service pipeline as the read tool, so the exported funnel and
//     source rows are the ones the screen shows (and the file says which
//     filters made it);
//   * every SLA aging bucket carries a stable drill-down key, and the
//     drill-down answers it with the applications behind the bucket: same
//     predicates as the payload, the caller's recruitment scope, paginated,
//     ids plus display fields;
//   * recruiter workload rows carry recruiterName next to recruiterId.
// The real service runs against a recorded prisma fake.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T00:00:00Z");
const day = (s) => new Date(`${s}T00:00:00Z`);

const prisma = {
    application: { findMany: jest.fn() },
    applicationScreening: { findMany: jest.fn(async () => []) },
    jobRequisition: { findMany: jest.fn() },
    employee: { findMany: jest.fn(async () => []) },
    internalReferral: { findMany: jest.fn(async () => []) },
};

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/services/recruitment-cost.service.js", () => ({ getCostConfig: jest.fn(async () => null) }));

const service = await import("../../../src/services/recruitment-analytics.service.js");
const { registerRecruitmentAnalyticsTools, filtersFromArgs } = await import("../../../src/mcp/tools/recruitment-analytics.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");

const handlers = new Map();
registerRecruitmentAnalyticsTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const RECRUITER = { userId: "1", roles: ["RECRUITER"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const MANAGER = { userId: "2", roles: ["HIRING_MANAGER"], isAdmin: false, employeeId: 42, tenantId: TENANT };
const GRANT = { "hr:recruitment": ["VIEW"] };
const call = (name, args, user = RECRUITER) => mcpCtx.run({ user, permissions: GRANT }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

// Applications as the shared loader selects them (legacy payload + export).
const loaderApp = (id, over = {}) => ({
    id,
    stage: "applied",
    appliedAt: day("2026-09-01"),
    updatedAt: day("2026-09-02"),
    candidate: { id: 100 + id, source: "LinkedIn" },
    jobRequisition: { id: 7, title: "Backend Engineer", departmentId: 3 },
    interviews: [],
    offer: null,
    ...over,
});
const LOADER_APPS = [
    loaderApp(1, { stage: "hired", appliedAt: day("2026-08-01") }),
    loaderApp(2, { stage: "interview", candidate: { id: 102, source: "Referral" } }),
    loaderApp(3, { stage: "screening", jobRequisition: { id: 8, title: "QA", departmentId: 4 } }),
    loaderApp(4, { stage: "applied", appliedAt: day("2026-10-10") }),
];

// The SLA fixture: requisition 7 (requested by manager 42) and 8 (someone else).
// Screening SLA 5 days, interview 10.
const historyApp = (id, stage, enteredAt, over = {}) => ({
    id,
    stage,
    appliedAt: day("2026-09-01"),
    candidate: { id: 100 + id, source: "LinkedIn", firstName: `First${id}`, lastName: `Last${id}` },
    jobRequisition: { id: 7, title: "Backend Engineer" },
    stageHistory: stage === "applied" ? [] : [{ fromStage: "applied", toStage: stage, createdAt: day(enteredAt) }],
    offer: null,
    screenings: [],
    ...over,
});
const SLA_APPS = [
    historyApp(11, "screening", "2026-10-01"), // 19 days, breached
    historyApp(12, "screening", "2026-10-18"), // 2 days, within SLA
    historyApp(13, "interview", "2026-09-20"), // 30 days, breached
    historyApp(14, "screening", "2026-09-25", { jobRequisition: { id: 8, title: "QA" } }), // 25 days, breached, other requisition
];

let savedEnv;
beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate"] });
    savedEnv = { flag: process.env.HR_RECRUITMENT_CANONICAL_ANALYTICS, sla: process.env.HR_RECRUITMENT_STAGE_SLA_DAYS };
    process.env.HR_RECRUITMENT_CANONICAL_ANALYTICS = "true";
    process.env.HR_RECRUITMENT_STAGE_SLA_DAYS = JSON.stringify({ screening: 5, interview: 10 });
    prisma.application.findMany.mockImplementation(async (args) => (args?.select?.stageHistory ? SLA_APPS : LOADER_APPS));
    prisma.jobRequisition.findMany.mockImplementation(async (args) => {
        if (args?.select?.transitions) {
            // The canonical fetch: requisitions with their applications.
            return [
                { id: 7, openings: 1, transitions: [], applications: SLA_APPS.filter((a) => a.jobRequisition.id === 7) },
                { id: 8, openings: 1, transitions: [], applications: SLA_APPS.filter((a) => a.jobRequisition.id === 8) },
            ];
        }
        // The workload fetch.
        return [
            { id: 7, status: "POSTED", recruiterId: 70, applications: [] },
            { id: 8, status: "POSTED", recruiterId: null, applications: [] },
        ];
    });
    prisma.employee.findMany.mockImplementation(async (args) =>
        args?.select?.first_name ? [{ id: 70, first_name: "Ayesha", last_name: "Khan", employee_name: null }] : [],
    );
});
afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [["HR_RECRUITMENT_CANONICAL_ANALYTICS", savedEnv.flag], ["HR_RECRUITMENT_STAGE_SLA_DAYS", savedEnv.sla]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const decodeCsv = (out) => Buffer.from(out.base64, "base64").toString("utf8");

describe("D9a — the export applies the dashboard's filters", () => {
    it("the read, the drill-down and the export build filters with one function", () => {
        expect(filtersFromArgs({ dateFrom: "2026-09-01", requisitionIds: ["7"], departmentId: "3", stage: "", source: "LinkedIn" })).toEqual({
            dateFrom: "2026-09-01",
            requisitionIds: [7],
            departmentId: 3,
            source: "LinkedIn",
        });
    });

    it("a filtered export holds exactly the funnel and source rows of the filtered read", async () => {
        const args = { dateFrom: "2026-08-15", dateTo: "2026-09-30", departmentId: "3" };
        const read = parse(await call("hr_recruitment_analytics_get", args));
        const out = parse(await call("hr_recruitment_analytics_export", { format: "csv", ...args }));

        // Department 3 between 15 Aug and 30 Sep: application 2 only.
        expect(read.hiringFunnel).toEqual({ applied: 1, screened: 1, interviewed: 0, offered: 0, hired: 0 });
        expect(out.filters).toEqual({ dateFrom: "2026-08-15T00:00:00.000Z", dateTo: "2026-09-30T00:00:00.000Z", departmentId: 3 });
        const csv = decodeCsv(out);
        for (const [stage, count] of Object.entries(read.hiringFunnel)) expect(csv).toContain(`Funnel,${stage},${count}`);
        for (const s of read.sourceEffectiveness) expect(csv).toContain(`Source,${s.source},${s.candidates},${s.hires}`);
        expect(csv).not.toContain("LinkedIn");
        expect(out.count).toBe(Object.keys(read.hiringFunnel).length + read.sourceEffectiveness.length);
    });

    it("without filters the export is unchanged (all applications) and echoes no filter", async () => {
        const out = parse(await call("hr_recruitment_analytics_export", { format: "csv" }));
        expect(out.filters).toEqual({});
        expect(decodeCsv(out)).toContain("Funnel,applied,4");
    });

    it("refuses an invalid filter like the read does", async () => {
        const out = await call("hr_recruitment_analytics_export", { format: "csv", dateFrom: "2026-10-01", dateTo: "2026-09-01" });
        expect(out.isError).toBe(true);
        expect(parse(out).jsonrpc.data.details).toMatchObject({ code: "HR-RECRUITMENT-ANALYTICS-FILTER-INVALID" });
    });
});

describe("D9b — SLA aging drill-down", () => {
    it("every bucket names its key, and the drill-down returns the rows behind each figure", async () => {
        const sla = (await service.computeRecruitmentAnalytics(TENANT, {}, { now: NOW })).canonicalMetrics.slaAging;
        expect(sla).toMatchObject({ drilldownKey: "sla:all", breachedDrilldownKey: "sla:all:breached", openApplications: 4, breached: 3 });
        expect(sla.byStage.screening).toMatchObject({
            open: 3, breached: 2, drilldownKey: "sla:screening", breachedDrilldownKey: "sla:screening:breached",
        });

        for (const [key, expected] of [
            [sla.drilldownKey, sla.openApplications],
            [sla.breachedDrilldownKey, sla.breached],
            [sla.byStage.screening.drilldownKey, sla.byStage.screening.open],
            [sla.byStage.screening.breachedDrilldownKey, sla.byStage.screening.breached],
            [sla.byStage.interview.breachedDrilldownKey, sla.byStage.interview.breached],
        ]) {
            const drill = parse(await call("hr_recruitment_analytics_drilldown", { metric: key }));
            expect([key, drill.total]).toEqual([key, expected]);
        }
    });

    it("rows are ids plus display fields, oldest in stage first", async () => {
        const drill = parse(await call("hr_recruitment_analytics_drilldown", { metric: "sla:screening:breached" }));
        expect(drill).toMatchObject({ unit: "application", configured: true, bucket: { stage: "screening", breachedOnly: true } });
        expect(drill.rows).toEqual([
            {
                applicationId: 14, candidateId: 114, candidateName: "First14 Last14", requisitionId: 8, requisitionTitle: "QA",
                source: "LinkedIn", appliedAt: "2026-09-01T00:00:00.000Z", stage: "screening", daysInStage: 25, slaDays: 5, agingDays: 20, breached: true,
            },
            expect.objectContaining({ applicationId: 11, daysInStage: 19, agingDays: 14 }),
        ]);
        for (const row of drill.rows) {
            expect(Object.keys(row).some((k) => /email|phone/i.test(k))).toBe(false);
        }
    });

    it("pages with offset and nextOffset", async () => {
        const first = parse(await call("hr_recruitment_analytics_drilldown", { metric: "sla:all", limit: "3" }));
        expect(first).toMatchObject({ total: 4, returned: 3, offset: 0, nextOffset: 3, truncated: true });
        const second = parse(await call("hr_recruitment_analytics_drilldown", { metric: "sla:all", limit: "3", offset: "3" }));
        expect(second).toMatchObject({ total: 4, returned: 1, offset: 3, nextOffset: null, truncated: false });
        expect([...first.rows, ...second.rows].map((r) => r.applicationId)).toEqual([13, 14, 11, 12]);
    });

    it("reads under the tenant, with the same requisition filters as the payload and the caller's scope", async () => {
        await call("hr_recruitment_analytics_drilldown", { metric: "sla:all", requisitionIds: ["7"], departmentId: "3" }, MANAGER);
        const where = prisma.application.findMany.mock.calls.at(-1)[0].where;
        expect(where.AND[0]).toEqual({ tenantId: TENANT, jobRequisition: service.canonicalRequisitionWhere(TENANT, { requisitionIds: [7], departmentId: 3 }) });
        expect(where.AND[1]).toEqual({ jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] } });
    });

    it("a scope with no recruitment rows gets the match-none predicate", async () => {
        await call("hr_recruitment_analytics_drilldown", { metric: "sla:all" }, { ...RECRUITER, roles: ["EMPLOYEE"] });
        expect(prisma.application.findMany.mock.calls.at(-1)[0].where.AND[1]).toEqual({ id: { in: [] } });
    });

    it("applies the stage, source and date filters like the payload", async () => {
        const drill = await service.drillDownRecruitmentMetric(TENANT, "sla:all", { stage: "interview" }, { now: NOW });
        expect(drill.rows.map((r) => r.applicationId)).toEqual([13]);
        const sla = (await service.computeRecruitmentAnalytics(TENANT, { stage: "interview" }, { now: NOW })).canonicalMetrics.slaAging;
        expect(sla.openApplications).toBe(1);
    });

    it("without an SLA the breached bucket is empty with the reason; the open bucket still lists rows", async () => {
        delete process.env.HR_RECRUITMENT_STAGE_SLA_DAYS;
        const breached = await service.drillDownRecruitmentMetric(TENANT, "sla:all:breached", {}, { now: NOW });
        expect(breached).toMatchObject({ total: 0, configured: false, reason: "SLA_NOT_CONFIGURED" });
        const open = await service.drillDownRecruitmentMetric(TENANT, "sla:screening", {}, { now: NOW });
        expect(open.total).toBe(3);
        expect(open.rows[0]).toMatchObject({ slaDays: null, agingDays: null, breached: false });
    });

    it("refuses a malformed SLA key", async () => {
        for (const bad of ["sla:", "sla:Screening", "sla:screening:late", "sla:screening:"]) {
            await expect(service.drillDownRecruitmentMetric(TENANT, bad)).rejects.toMatchObject({ code: "HR-RECRUITMENT-ANALYTICS-DRILLDOWN-INVALID" });
        }
        expect(service.slaDrilldownKey("on_hold", { breached: true })).toBe("sla:on_hold:breached");
        expect(service.parseSlaDrilldownKey("sla:on_hold:breached")).toEqual({ stage: "on_hold", breachedOnly: true });
    });
});

describe("D10 — recruiter names in the workload", () => {
    it("adds recruiterName next to recruiterId (null for no recruiter), one lookup under the tenant", async () => {
        const res = await service.computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(res.canonicalMetrics.recruiterWorkload.recruiters).toEqual([
            expect.objectContaining({ recruiterId: 70, recruiterName: "Ayesha Khan" }),
            expect.objectContaining({ recruiterId: null, recruiterName: null }),
        ]);
        const lookups = prisma.employee.findMany.mock.calls.filter(([a]) => a?.select?.first_name);
        expect(lookups).toHaveLength(1);
        expect(lookups[0][0].where).toMatchObject({ id: { in: [70] }, tenant_id: TENANT });
        expect(lookups[0][0].select).toEqual({ id: true, first_name: true, last_name: true, employee_name: true });
    });

    it("the workload drill-down rows carry the name too", async () => {
        const drill = await service.drillDownRecruitmentMetric(TENANT, "recruiterWorkload", {}, { now: NOW });
        expect(drill.rows[0]).toMatchObject({ recruiterId: 70, recruiterName: "Ayesha Khan" });
    });

    it("a failed name lookup leaves the names null, the figures intact", async () => {
        prisma.employee.findMany.mockImplementation(async (args) => {
            if (args?.select?.first_name) throw new Error("db hiccup");
            return [];
        });
        const res = await service.computeRecruitmentAnalytics(TENANT, {}, { now: NOW });
        expect(res.canonicalMetrics.unavailable).toBeUndefined();
        expect(res.canonicalMetrics.recruiterWorkload.recruiters[0]).toMatchObject({ recruiterId: 70, recruiterName: null, openRequisitions: 1 });
    });
});

describe("scope helper sanity", () => {
    it("the manager fixture resolves to MANAGED", () => {
        expect(resolveRecruitmentScope(MANAGER).level).toBe("MANAGED");
    });
});
