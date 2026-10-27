// Phase 2 source attribution report: counted in the database by sourceChannel,
// cut to the caller's scope, with null reported as UNKNOWN.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const db = { application: { groupBy: jest.fn() } };
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const { getRecruitmentSourceReport, mergeSourceCounts, buildSourceReportWhere } = await import(
    "../../../src/services/recruitment-source.service.js"
);
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORG = resolveRecruitmentScope({ isAdmin: true, roles: [] });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 9 });

beforeEach(() => {
    jest.clearAllMocks();
    db.application.groupBy.mockImplementation(async ({ where }) =>
        where.stage === "hired"
            ? [{ sourceChannel: "INDEED", _count: { _all: 1 } }, { sourceChannel: null, _count: { _all: 1 } }]
            : [
                { sourceChannel: "INDEED", _count: { _all: 4 } },
                { sourceChannel: null, _count: { _all: 3 } },
                { sourceChannel: "LINKEDIN", _count: { _all: 6 } },
            ]);
});

describe("getRecruitmentSourceReport", () => {
    it("groups by sourceChannel, buckets null as UNKNOWN and adds hired counts", async () => {
        const report = await getRecruitmentSourceReport({ tenantId: TENANT, scope: ORG });
        expect(report.sources).toEqual([
            { channel: "LINKEDIN", applications: 6, hired: 0, hireRate: 0 },
            { channel: "INDEED", applications: 4, hired: 1, hireRate: 25 },
            { channel: "UNKNOWN", applications: 3, hired: 1, hireRate: 33.3 },
        ]);
        expect(report.totals).toEqual({ applications: 13, hired: 2 });
        const [all, hired] = db.application.groupBy.mock.calls.map(([args]) => args);
        expect(all.by).toEqual(["sourceChannel"]);
        expect(all.where).toEqual({ tenantId: TENANT, AND: [{}] });
        expect(hired.where).toEqual({ tenantId: TENANT, AND: [{}], stage: "hired" });
    });

    it("applies the caller's application scope to both queries", async () => {
        await getRecruitmentSourceReport({ tenantId: TENANT, scope: MANAGER });
        for (const [args] of db.application.groupBy.mock.calls) {
            expect(args.where.tenantId).toBe(TENANT);
            expect(args.where.AND[0]).toEqual({
                jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] },
            });
        }
    });

    it("gives FINANCE a predicate that matches nothing", async () => {
        await getRecruitmentSourceReport({ tenantId: TENANT, scope: FINANCE });
        expect(db.application.groupBy.mock.calls[0][0].where.AND[0]).toEqual({ id: { in: [] } });
    });

    it("filters by requisition and an inclusive appliedAt range (date-only 'to' covers the day)", async () => {
        const report = await getRecruitmentSourceReport({
            tenantId: TENANT, scope: ORG, requisitionId: "9", from: "2026-10-01", to: "2026-10-31",
        });
        const { where } = db.application.groupBy.mock.calls[0][0];
        expect(where.AND).toEqual([
            {},
            { jobRequisitionId: 9 },
            { appliedAt: { gte: new Date("2026-10-01T00:00:00.000Z"), lte: new Date("2026-10-31T23:59:59.999Z") } },
        ]);
        expect(report.filters).toEqual({
            requisitionId: 9, from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z",
        });
    });

    it("rejects bad filters with 400", async () => {
        for (const args of [{ requisitionId: "abc" }, { from: "nope" }, { from: "2026-10-31", to: "2026-10-01" }]) {
            await expect(getRecruitmentSourceReport({ tenantId: TENANT, scope: ORG, ...args }))
                .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SOURCE-REPORT-INVALID" });
        }
        expect(db.application.groupBy).not.toHaveBeenCalled();
    });

    it("requires a tenant", async () => {
        await expect(getRecruitmentSourceReport({ scope: ORG })).rejects.toMatchObject({ status: 403 });
    });
});

describe("pure helpers", () => {
    it("merges hired-only channels and an empty result", () => {
        expect(mergeSourceCounts([], [])).toEqual([]);
        expect(mergeSourceCounts([], [{ sourceChannel: "REFERRAL", _count: { _all: 1 } }]))
            .toEqual([{ channel: "REFERRAL", applications: 0, hired: 1, hireRate: 0 }]);
    });

    it("keeps the scope's OR apart from the filters", () => {
        const where = buildSourceReportWhere({ tenantId: TENANT, scope: MANAGER, requisitionId: 3 });
        expect(where).toEqual({
            tenantId: TENANT,
            AND: [{ jobRequisition: { OR: [{ requestedById: 42 }, { approvedById: 42 }] } }, { jobRequisitionId: 3 }],
        });
    });
});
