// Recruitment Phase 3a — offer letter templates (immutable versions, newest
// active wins, built-in default) and rendered letter versions (numbering, the
// offer's letter pointer, the event, scope gates and masking, closed offers).
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

import { createOfferLetterDb } from "./helpers/offer-letter.fake.js";

const { db, store } = createOfferLetterDb();
const events = [];
const enqueueHrDomainEvent = jest.fn(async (_tx, event) => {
    events.push(event);
    return event;
});
const getRecruitmentSettings = jest.fn(async () => ({ companyName: "TruSoft", timeZone: "Asia/Karachi" }));
const uploadFileToDAM = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM }));

const svc = await import("../../../src/services/offer-letter.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORG = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 7 });
const FINANCE = resolveRecruitmentScope({ roles: ["FINANCE"], employeeId: 9 });
const MANAGER = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 42 });
const INTERVIEWER = resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 50 });
const NOW = new Date("2026-10-20T06:00:00Z");

const asTenant = (fn, tenantId = TENANT) => mcpCtx.run({ user: { tenantId, employeeId: 7 } }, async () => await fn());

const offerRow = (over = {}) => ({
    id: 1,
    tenantId: TENANT,
    applicationId: 901,
    candidateId: 77,
    jobRequisitionId: 9,
    status: "DRAFT",
    salary: 250000,
    currency: "PKR",
    startDate: new Date("2026-11-01T00:00:00Z"),
    expiryDate: new Date("2026-10-30T00:00:00Z"),
    offerType: "Standard",
    employmentType: "Full-time",
    terms: { probationMonths: 3, noticePeriodDays: 30, department: "Sales" },
    compensation: { baseSalary: 250000, currency: "PKR", benefits: ["Medical"] },
    offerLetterMediaId: null,
    candidate: { id: 77, firstName: "Zoe", lastName: "Khan", email: "zoe@example.com" },
    jobRequisition: { id: 9, title: "Sales Lead", requestedById: 42 },
    application: { id: 901, jobRequisition: { requestedById: 42 } },
    ...over,
});

const ENV_KEYS = ["HR_RECRUITMENT_OFFER_LETTERS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

let mediaSeq;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_OFFER_LETTERS = "true";
    for (const key of Object.keys(store)) store[key].length = 0;
    db.contextLog.length = 0;
    events.length = 0;
    mediaSeq = 500;
    uploadFileToDAM.mockImplementation(async () => [{ id: ++mediaSeq }]);
    store.offer.push(offerRow());
});

const save = (over = {}, scope = ORG) =>
    asTenant(() => svc.saveOfferLetterTemplate({ tenantId: TENANT, scope, actorId: 7, key: "STANDARD", name: "Std", subject: "Offer: {{job.title}}", body: "Dear {{candidate.firstName}},\n\nSalary {{offer.currency}} {{offer.salary}}.", ...over }));
const render = (over = {}) => asTenant(() => svc.renderOfferLetterVersion({ tenantId: TENANT, scope: ORG, offerId: 1, actorId: 7, now: NOW, ...over }));

describe("templates", () => {
    it("saving creates the next version and keeps the old one active", async () => {
        const v1 = await save();
        const v2 = await save({ name: "Std v2" });
        expect([v1.version, v2.version]).toEqual([1, 2]);
        expect(store.offerLetterTemplate.map((t) => t.active)).toEqual([true, true]);
        const list = await asTenant(() => svc.listOfferLetterTemplates({ tenantId: TENANT, scope: ORG }));
        expect(list.items.map((t) => [t.version, t.inUse])).toEqual([[2, true], [1, false]]);
        expect(list.builtInDefault).toMatchObject({ key: "STANDARD", version: 0, builtIn: true, inUse: false });
    });

    it("is ORG only to save or deactivate, and validates the body", async () => {
        await expect(save({}, MANAGER)).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-OFFER-LETTER-FORBIDDEN" });
        await expect(save({ body: "Hi {{candidate.email}}" })).rejects.toMatchObject({ status: 422, code: "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-INVALID" });
        await expect(save({ key: "!!" })).rejects.toMatchObject({ status: 422 });
        const v1 = await save();
        await expect(asTenant(() => svc.deactivateOfferLetterTemplate({ tenantId: TENANT, scope: FINANCE, id: v1.id }))).rejects.toMatchObject({ status: 403 });
        expect(store.offerLetterTemplate).toHaveLength(1);
    });

    it("deactivating the newest version falls back to the previous one, then to the built-in default", async () => {
        const v1 = await save();
        const v2 = await save({ body: "Version two for {{candidate.firstName}}" });
        let used = await asTenant(() => svc.resolveOfferLetterTemplate({ tenantId: TENANT, key: "STANDARD" }));
        expect(used.id).toBe(v2.id);
        const off = await asTenant(() => svc.deactivateOfferLetterTemplate({ tenantId: TENANT, scope: ORG, id: v2.id }));
        expect(off).toMatchObject({ active: false, alreadyInactive: false });
        used = await asTenant(() => svc.resolveOfferLetterTemplate({ tenantId: TENANT, key: "STANDARD" }));
        expect(used.id).toBe(v1.id);
        await asTenant(() => svc.deactivateOfferLetterTemplate({ tenantId: TENANT, scope: ORG, id: v1.id }));
        used = await asTenant(() => svc.resolveOfferLetterTemplate({ tenantId: TENANT, key: "STANDARD" }));
        expect(used).toMatchObject({ builtIn: true, version: 0 });
    });

    it("an offer type without a template uses STANDARD; an explicit unknown key is 404", async () => {
        const std = await save();
        const used = await asTenant(() => svc.resolveOfferLetterTemplate({ tenantId: TENANT, key: "Internship" }));
        expect(used.id).toBe(std.id);
        await expect(asTenant(() => svc.resolveOfferLetterTemplate({ tenantId: TENANT, key: "CONTRACT", explicit: true }))).rejects.toMatchObject({
            status: 404,
            code: "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-NOT-FOUND",
        });
    });

    it("another tenant's templates are invisible", async () => {
        await save();
        const list = await asTenant(() => svc.listOfferLetterTemplates({ tenantId: OTHER, scope: ORG }), OTHER);
        expect(list.items).toEqual([]);
        expect(list.builtInDefault.inUse).toBe(true);
    });

    it("interviewers see no templates", async () => {
        await save();
        const list = await asTenant(() => svc.listOfferLetterTemplates({ tenantId: TENANT, scope: INTERVIEWER }));
        expect(list.items).toEqual([]);
    });

    it("refuses everything with the flag off", async () => {
        process.env.HR_RECRUITMENT_OFFER_LETTERS = "false";
        await expect(save()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-OFFER-LETTERS-DISABLED" });
        await expect(render()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-OFFER-LETTERS-DISABLED" });
        await expect(asTenant(() => svc.listOfferLetterVersions({ tenantId: TENANT, scope: ORG, offerId: 1 }))).rejects.toMatchObject({ status: 503 });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });
});

describe("rendering letter versions", () => {
    it("renders the built-in default, stores the PDF and points the offer at it", async () => {
        const out = await render();
        expect(out.replayed).toBe(false);
        expect(out.template).toMatchObject({ key: "STANDARD", version: 0, builtIn: true });
        expect(out.version).toMatchObject({ version: 1, templateKey: "STANDARD", templateVersion: 0, mediaId: 501, signatureStatus: "NONE" });
        expect(out.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(store.offer[0].offerLetterMediaId).toBe(501);
        expect(store.offerLetterVersion[0].createdAt.toISOString()).toBe(NOW.toISOString());
        const [file] = uploadFileToDAM.mock.calls[0];
        expect(file.mimetype).toBe("application/pdf");
        expect(file.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        expect(events).toEqual([
            expect.objectContaining({
                eventName: "hr.recruitment.offer_letter_rendered.v1",
                tenantId: TENANT,
                payload: { offerLetterVersionId: String(store.offerLetterVersion[0].id), offerId: "1", version: 1, templateKey: "STANDARD", templateVersion: 0 },
            }),
        ]);
        // No salary or name in the event.
        expect(JSON.stringify(events)).not.toMatch(/250|Zoe/);
    });

    it("numbers versions and moves the offer's letter to the newest", async () => {
        await render();
        await save({ body: "New letter for {{candidate.firstName}}" });
        const second = await render();
        expect(second.version).toMatchObject({ version: 2, templateVersion: 1, mediaId: 502 });
        expect(store.offer[0].offerLetterMediaId).toBe(502);
        const list = await asTenant(() => svc.listOfferLetterVersions({ tenantId: TENANT, scope: ORG, offerId: 1 }));
        expect(list.items.map((v) => [v.version, v.isCurrent])).toEqual([[2, true], [1, false]]);
    });

    it("an unchanged render replays the newest version", async () => {
        const first = await render();
        const again = await render();
        expect(again.replayed).toBe(true);
        expect(again.version.id).toBe(first.version.id);
        expect(uploadFileToDAM).toHaveBeenCalledTimes(1);
        expect(store.offerLetterVersion).toHaveLength(1);
    });

    it("preview stores nothing and reports missing fields", async () => {
        store.offer[0].terms = {};
        const out = await render({ preview: true });
        expect(out.preview).toBe(true);
        expect(out.paragraphs.join("\n")).toContain("Dear Zoe Khan,");
        expect(out.paragraphs.join("\n")).toContain("PKR 250,000");
        expect(out.warnings.map((w) => w.field)).toEqual(["offer.probationMonths", "offer.noticePeriodDays"]);
        expect(store.offerLetterVersion).toHaveLength(0);
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it.each(["ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN"])("is refused for a %s offer", async (status) => {
        store.offer[0].status = status;
        await expect(render()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-FINALIZED" });
        expect(uploadFileToDAM).not.toHaveBeenCalled();
    });

    it("is refused while the newest letter is out for signature", async () => {
        await render();
        store.offerLetterVersion[0].signatureStatus = "SENT";
        store.offer[0].terms = { probationMonths: 6 };
        await expect(render()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-LETTER-OUT-FOR-SIGNATURE" });
    });

    it("re-checks the offer inside the transaction", async () => {
        // The offer is accepted between the pre-read and the write.
        uploadFileToDAM.mockImplementation(async () => {
            store.offer[0].status = "ACCEPTED";
            return [{ id: 900 }];
        });
        await expect(render()).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-FINALIZED" });
        expect(store.offerLetterVersion).toHaveLength(0);
        expect(events).toHaveLength(0);
    });

    it("only scopes that may see compensation may render", async () => {
        await expect(asTenant(() => svc.renderOfferLetterVersion({ tenantId: TENANT, scope: MANAGER, offerId: 1, now: NOW }))).rejects.toMatchObject({ status: 403 });
        const byFinance = await asTenant(() => svc.renderOfferLetterVersion({ tenantId: TENANT, scope: FINANCE, offerId: 1, now: NOW }));
        expect(byFinance.version.mediaId).toBe(501);
    });

    it("another tenant's offer is not found", async () => {
        await expect(asTenant(() => svc.renderOfferLetterVersion({ tenantId: OTHER, scope: ORG, offerId: 1, now: NOW }), OTHER)).rejects.toMatchObject({ status: 404 });
    });

    it("runs every query inside the tenant context", async () => {
        await render();
        expect(db.contextLog.length).toBeGreaterThan(0);
        expect(db.contextLog.every((q) => q.tenantId === TENANT && !q.system)).toBe(true);
    });
});

describe("listing versions", () => {
    it("withholds media ids and hashes from scopes without compensation", async () => {
        await render();
        store.offerLetterVersion[0].signedMediaId = 777;
        const org = await asTenant(() => svc.listOfferLetterVersions({ tenantId: TENANT, scope: ORG, offerId: 1 }));
        expect(org.items[0]).toMatchObject({ mediaId: 501, signedMediaId: 777 });
        expect(org.items[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
        const mgr = await asTenant(() => svc.listOfferLetterVersions({ tenantId: TENANT, scope: MANAGER, offerId: 1 }));
        expect(mgr.items[0]).toMatchObject({ mediaId: null, signedMediaId: null, contentHash: null, mediaRedacted: true, signatureStatus: "NONE" });
    });

    it("an offer outside the scope reads as not found", async () => {
        await expect(asTenant(() => svc.listOfferLetterVersions({ tenantId: TENANT, scope: INTERVIEWER, offerId: 1 }))).rejects.toMatchObject({ status: 404 });
        const otherManager = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 99 });
        await expect(asTenant(() => svc.listOfferLetterVersions({ tenantId: TENANT, scope: otherManager, offerId: 1 }))).rejects.toMatchObject({ status: 404 });
    });
});
