// Phase 2 job feed service: one null for every not-found reason, the token
// lookup under SYSTEM context and the job read under the token's tenant, the
// channel filter, the apply URL, and nothing private in the document.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

const contexts = [];
const db = {
    tenantRecruitmentSettings: { findUnique: jest.fn() },
    jobRequisition: { findMany: jest.fn() },
};

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));

const { mcpCtx } = await import("../../../src/mcp/context.js");
const {
    buildApplyUrl,
    buildJobFeedUrls,
    getJobFeed,
    MAX_FEED_JOBS,
    normalizeFeedChannel,
    tokensMatch,
} = await import("../../../src/services/job-feed.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NOW = new Date("2026-10-20T12:00:00Z");

const SETTINGS = {
    tenantId: TENANT,
    feedToken: TOKEN,
    feedEnabled: true,
    companyName: "Acme",
    companyUrl: "https://acme.test/",
    portalBaseUrl: "https://careers.acme.test/",
};

// What the select can return. The test feeds extra private columns in as well,
// to prove the projection, not the query, is what keeps them out.
const REQUISITION = {
    id: 42,
    title: "Backend Engineer",
    location: "Lahore, Pakistan",
    employmentType: "FULL_TIME",
    publishedAt: new Date("2026-10-01T00:00:00Z"),
    jobContent: { summary: "Build the HR platform", skills: ["Node.js"] },
    postings: [{ id: 7, postedAt: new Date("2026-10-02T00:00:00Z") }],
    budgetedAmount: "999999",
    requirements: "INTERNAL NOTE: shortlist only ex-colleagues",
    requestedById: 5,
    approvalChainSnapshot: { approver: "Jane CFO" },
    gradeLevel: { minSalary: 123456, maxSalary: 234567 },
};

const ORIGINAL_FLAG = process.env.HR_RECRUITMENT_JOB_FEED;

// Prisma queries are lazy thenables: they run, and the extensions read the
// request context, when awaited. The mocks record the context at that moment,
// so a query awaited outside mcpCtx.run would be caught here.
const lazyQuery = (model, value) => ({
    then(resolve, reject) {
        contexts.push({ model, store: mcpCtx.getStore() });
        return Promise.resolve(value).then(resolve, reject);
    },
});

beforeEach(() => {
    jest.clearAllMocks();
    contexts.length = 0;
    process.env.HR_RECRUITMENT_JOB_FEED = "true";
    db.tenantRecruitmentSettings.findUnique.mockImplementation(() => lazyQuery("settings", { ...SETTINGS }));
    db.jobRequisition.findMany.mockImplementation(() => lazyQuery("requisition", [{ ...REQUISITION }]));
});

afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HR_RECRUITMENT_JOB_FEED;
    else process.env.HR_RECRUITMENT_JOB_FEED = ORIGINAL_FLAG;
});

describe("getJobFeed — not found", () => {
    it("returns null with the flag off, without touching the database", async () => {
        process.env.HR_RECRUITMENT_JOB_FEED = "false";
        expect(await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW })).toBeNull();
        expect(db.tenantRecruitmentSettings.findUnique).not.toHaveBeenCalled();
    });

    it("returns null for a malformed token before any lookup", async () => {
        for (const token of ["", "short", "has spaces in it padding!!", "x".repeat(200), null]) {
            expect(await getJobFeed({ token, channel: "indeed", now: NOW })).toBeNull();
        }
        expect(db.tenantRecruitmentSettings.findUnique).not.toHaveBeenCalled();
    });

    it("returns null for an unknown token", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce(null);
        expect(await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW })).toBeNull();
        expect(db.jobRequisition.findMany).not.toHaveBeenCalled();
    });

    it("returns null when the tenant switched the feed off", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce({ ...SETTINGS, feedEnabled: false });
        expect(await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW })).toBeNull();
        expect(db.jobRequisition.findMany).not.toHaveBeenCalled();
    });

    it("returns null for a channel that is not a feed channel", async () => {
        for (const channel of ["career_site", "agency", "referral", "", undefined]) {
            expect(await getJobFeed({ token: TOKEN, channel, now: NOW })).toBeNull();
        }
        expect(db.tenantRecruitmentSettings.findUnique).not.toHaveBeenCalled();
    });
});

describe("getJobFeed — the document", () => {
    it("looks the token up under SYSTEM context and reads jobs under the tenant's own context", async () => {
        const feed = await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW });
        expect(feed).toMatchObject({ tenantId: TENANT, channel: "INDEED", jobCount: 1 });
        expect(db.tenantRecruitmentSettings.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { feedToken: TOKEN } }),
        );
        expect(contexts[0]).toEqual({ model: "settings", store: { system: true } });
        expect(contexts[1].model).toBe("requisition");
        expect(contexts[1].store).toEqual({ user: { tenantId: TENANT } });
    });

    it("filters requisitions to POSTED, open window, an active posting on the requested channel, tenant pinned and capped", async () => {
        await getJobFeed({ token: TOKEN, channel: "linkedin", now: NOW });
        const args = db.jobRequisition.findMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: TENANT,
            status: "POSTED",
            OR: [{ closesAt: null }, { closesAt: { gte: NOW } }],
            postings: { some: { tenantId: TENANT, channel: "LINKEDIN", isActive: true, closedAt: null } },
        });
        expect(args.select.postings.where).toEqual({ tenantId: TENANT, channel: "LINKEDIN", isActive: true, closedAt: null });
        expect(args.take).toBe(MAX_FEED_JOBS);
        // The projection names no private column.
        expect(Object.keys(args.select).sort()).toEqual(
            ["employmentType", "id", "jobContent", "location", "postings", "publishedAt", "title"],
        );
    });

    it("carries the apply URL with the channel and posting, and no private field", async () => {
        const { xml } = await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW });
        expect(xml).toContain("<url><![CDATA[https://careers.acme.test/jobs/42?source=INDEED&posting=7]]></url>");
        expect(xml).toContain("<referencenumber><![CDATA[42]]></referencenumber>");
        expect(xml).toContain("<company><![CDATA[Acme]]></company>");
        expect(xml).toContain("<city><![CDATA[Lahore]]></city>");
        expect(xml).toContain("<country><![CDATA[Pakistan]]></country>");
        expect(xml).toContain("<jobtype><![CDATA[fulltime]]></jobtype>");
        expect(xml).toContain("Build the HR platform");
        for (const secret of ["999999", "INTERNAL NOTE", "Jane CFO", "123456", "234567", TOKEN]) {
            expect(xml).not.toContain(secret);
        }
    });

    it("leaves every job out, but still renders, when portalBaseUrl is not set", async () => {
        db.tenantRecruitmentSettings.findUnique.mockResolvedValueOnce({ ...SETTINGS, portalBaseUrl: null });
        const feed = await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW });
        expect(feed.jobCount).toBe(0);
        expect(feed.xml).toContain("<source>");
        expect(feed.xml).not.toContain("<job>");
    });

    it("leaves out a requisition whose posting list came back empty", async () => {
        db.jobRequisition.findMany.mockResolvedValueOnce([{ ...REQUISITION, postings: [] }]);
        const feed = await getJobFeed({ token: TOKEN, channel: "indeed", now: NOW });
        expect(feed.jobCount).toBe(0);
    });
});

describe("feed helpers", () => {
    it("normalizes only the two feed channels", () => {
        expect(normalizeFeedChannel("indeed")).toBe("INDEED");
        expect(normalizeFeedChannel("LinkedIn")).toBe("LINKEDIN");
        expect(normalizeFeedChannel("CAREER_SITE")).toBeNull();
    });

    it("builds the apply URL exactly and refuses one without a base", () => {
        expect(buildApplyUrl({ portalBaseUrl: "https://c.test/careers/", requisitionId: 9, channel: "LINKEDIN", postingId: 3 }))
            .toBe("https://c.test/careers/jobs/9?source=LINKEDIN&posting=3");
        expect(buildApplyUrl({ portalBaseUrl: null, requisitionId: 9, channel: "INDEED", postingId: 3 })).toBeNull();
    });

    it("builds feed paths per channel, absolute only with a configured base", () => {
        expect(buildJobFeedUrls(TOKEN, { baseUrl: "https://hr.acme.test/" })).toEqual({
            paths: {
                INDEED: `/public/feeds/${TOKEN}/indeed.xml`,
                LINKEDIN: `/public/feeds/${TOKEN}/linkedin.xml`,
            },
            urls: {
                INDEED: `https://hr.acme.test/public/feeds/${TOKEN}/indeed.xml`,
                LINKEDIN: `https://hr.acme.test/public/feeds/${TOKEN}/linkedin.xml`,
            },
        });
        expect(buildJobFeedUrls(TOKEN, { baseUrl: "" }).urls).toEqual({ INDEED: null, LINKEDIN: null });
        expect(buildJobFeedUrls(null)).toBeNull();
    });

    it("compares tokens of any length safely", () => {
        expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
        expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
        expect(tokensMatch(null, TOKEN)).toBe(false);
    });
});
