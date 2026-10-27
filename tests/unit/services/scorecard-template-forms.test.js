// tests/unit/services/scorecard-template-forms.test.js
//
// Recruitment Phase 3b — evaluation forms on the scorecard templates:
// versions by templateKey (DRAFT / PUBLISHED / RETIRED, published immutable),
// the new INTERVIEW_TYPE and PANEL_ROLE scopes and the resolution order,
// backward compatibility for templates without sections and with the flag
// off, and pinning the form on an interview.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb } from "./helpers/evaluation-form.fake.js";

const { db, store } = createFakeDb();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const svc = await import("../../../src/services/scorecard-template.service.js");
const { resolveTemplate, latestPublishedVersion, FORM_TEMPLATE_SCOPES, TEMPLATE_SCOPES } = await import("../../../src/lib/scorecard-templates.util.js");
const { tenantTransaction } = await import("../../../src/lib/rlsTenant.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T = "22222222-2222-4222-8222-222222222222";
const as = (fn) => mcpCtx.run({ user: { tenantId: T, employeeId: 7, roles: ["RECRUITER"] } }, async () => await fn());

const a5 = { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" };
const SECTIONS = [{ key: "tech", label: "Tech", criteria: [{ key: "sql", competencyKey: "sql", weight: 2, anchors: a5 }] }];

function seed() {
    for (const key of Object.keys(store)) store[key].length = 0;
    store.requisitions.push({ id: 5, tenantId: T, title: "Analyst", requestedById: 30, positionId: 9 });
    store.applications.push({ id: 11, tenantId: T, candidateId: 3, jobRequisitionId: 5, stage: "interview" });
    store.interviews.push({ id: 100, tenantId: T, applicationId: 11, interviewType: "TECHNICAL", formTemplateId: null, formTemplateVersion: null });
}

beforeEach(() => {
    process.env.HR_RECRUITMENT_EVALUATION_FORMS = "true";
    seed();
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
});

describe("resolveTemplate order (pure)", () => {
    const mk = (id, scopeType, { scopeId = null, scopeKey = null, ...t } = {}) => ({ scopeType, scopeId, scopeKey, template: { id, ...t } });
    const ctx = { jobRequisitionId: 42, positionId: 7, interviewType: "TECHNICAL", panelRole: "HR", stage: "interview" };

    it("REQUISITION, then interview type and panel role, then stage, then job family", () => {
        const links = [
            mk(1, "JOB_FAMILY", { scopeId: 7 }),
            mk(2, "STAGE", { scopeKey: "TECHNICAL" }),
            mk(3, "PANEL_ROLE", { scopeKey: "HR" }),
            mk(4, "INTERVIEW_TYPE", { scopeKey: "TECHNICAL" }),
            mk(5, "INTERVIEW_TYPE", { scopeKey: "TECHNICAL" }), mk(5, "PANEL_ROLE", { scopeKey: "HR" }),
            mk(6, "REQUISITION", { scopeId: 42 }),
        ];
        expect(resolveTemplate(links, ctx).id).toBe(6);
        expect(resolveTemplate(links.slice(0, 6), ctx).id).toBe(5); // linked by both
        expect(resolveTemplate(links.slice(0, 4), ctx).id).toBe(4); // interview type
        expect(resolveTemplate(links.slice(0, 3), ctx).id).toBe(3); // panel role
        expect(resolveTemplate(links.slice(0, 2), ctx).id).toBe(2); // stage
        expect(resolveTemplate(links.slice(0, 1), ctx).id).toBe(1); // job family
    });

    it("STAGE matches the interview type (as before) or the application stage", () => {
        expect(resolveTemplate([mk(9, "STAGE", { scopeKey: "interview" })], ctx).id).toBe(9);
        expect(resolveTemplate([mk(9, "STAGE", { scopeKey: "interview" })], { ...ctx, stage: null })).toBeNull();
    });

    it("skips a template declared for another interview type or panel role, and prefers the matching one", () => {
        const links = [mk(1, "REQUISITION", { scopeId: 42, interviewType: "PHONE_SCREEN" }), mk(2, "JOB_FAMILY", { scopeId: 7 })];
        expect(resolveTemplate(links, ctx).id).toBe(2);
        const both = [mk(3, "REQUISITION", { scopeId: 42 }), mk(8, "REQUISITION", { scopeId: 42, panelRole: "HR" })];
        expect(resolveTemplate(both, ctx).id).toBe(8);
        expect(resolveTemplate(both, { ...ctx, panelRole: null }).id).toBe(3);
    });

    it("a link follows its key to the latest PUBLISHED version; keyless templates are their own", () => {
        const v1 = { id: 1, templateKey: "k", version: 1 };
        expect(latestPublishedVersion(v1, [{ id: 1, templateKey: "k", version: 1 }, { id: 2, templateKey: "k", version: 3 }]).id).toBe(2);
        expect(latestPublishedVersion(v1, [])).toBeNull();
        expect(latestPublishedVersion({ id: 4 }, [])).toEqual({ id: 4 });
        expect(TEMPLATE_SCOPES).toEqual(["REQUISITION", "STAGE", "JOB_FAMILY"]);
        expect(FORM_TEMPLATE_SCOPES).toEqual(["REQUISITION", "STAGE", "JOB_FAMILY", "INTERVIEW_TYPE", "PANEL_ROLE"]);
    });
});

describe("form templates: versions and publishing", () => {
    it("creates a form as DRAFT v1 with a key; a draft never resolves", async () => {
        const row = await as(() => svc.createTemplate({ name: "Analyst form", sections: SECTIONS, tenantId: T, actorId: 7 }));
        expect(row).toMatchObject({ status: "DRAFT", version: 1, publishedAt: null });
        expect(row.templateKey).toMatch(/^analyst-form-[0-9a-f]{6}$/);
        expect(row.criteria).toEqual([{ key: "sql", label: "sql", weight: 2, required: true, numeric: false }]);
        await as(() => svc.linkTemplate({ templateId: row.id, scopeType: "REQUISITION", scopeId: 5, tenantId: T }));
        expect(await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }))).toBeNull();
    });

    it("refuses an invalid form at creation", async () => {
        await expect(as(() => svc.createTemplate({ name: "Bad", sections: [{ key: "s", criteria: [{ key: "x", competencyKey: "x", anchors: { 1: "a" } }] }], tenantId: T })))
            .rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-TEMPLATE-FORM-INVALID" });
    });

    it("publishing validates and makes it resolve; a change to a PUBLISHED version is the next version; publishing that retires the old one", async () => {
        const v1 = await as(() => svc.createTemplate({ name: "Analyst form", sections: SECTIONS, tenantId: T }));
        await as(() => svc.linkTemplate({ templateId: v1.id, scopeType: "REQUISITION", scopeId: 5, tenantId: T }));
        const pub = await as(() => svc.updateTemplate({ templateId: v1.id, status: "PUBLISHED", tenantId: T }));
        expect(pub).toMatchObject({ status: "PUBLISHED", version: 1 });
        expect(pub.publishedAt).toBeTruthy();
        expect((await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }))).id).toBe(v1.id);

        const changed = [{ ...SECTIONS[0], criteria: [{ ...SECTIONS[0].criteria[0], weight: 3 }] }];
        const v2 = await as(() => svc.updateTemplate({ templateId: v1.id, sections: changed, tenantId: T }));
        expect(v2).toMatchObject({ newVersion: true, version: 2, status: "DRAFT", templateKey: v1.templateKey, previousVersionId: v1.id });
        // Published is immutable: v1 is untouched and still the live version.
        expect(store.templates.find((t) => t.id === v1.id).sections[0].criteria[0].weight).toBe(2);
        expect((await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }))).id).toBe(v1.id);

        await as(() => svc.updateTemplate({ templateId: v2.id, status: "PUBLISHED", tenantId: T }));
        expect(store.templates.find((t) => t.id === v1.id).status).toBe("RETIRED");
        // The link still points at v1's row and follows the key to v2.
        const resolved = await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }));
        expect(resolved).toMatchObject({ id: v2.id, version: 2, source: "TEMPLATE" });
        expect(resolved.sections[0].criteria[0].weight).toBe(3);
    });

    it("retires on request and refuses changes to a retired version", async () => {
        const v1 = await as(() => svc.createTemplate({ name: "F", sections: SECTIONS, status: "PUBLISHED", tenantId: T }));
        const retired = await as(() => svc.updateTemplate({ templateId: v1.id, status: "RETIRED", tenantId: T }));
        expect(retired.status).toBe("RETIRED");
        await expect(as(() => svc.updateTemplate({ templateId: v1.id, name: "G", tenantId: T }))).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-TEMPLATE-RETIRED" });
    });

    it("an old criteria template edited with the flag on gets a new PUBLISHED version, so its edits still take effect", async () => {
        store.templates.push({ id: 1, tenantId: T, name: "Old", criteria: [{ key: "a", label: "a", weight: null, required: true, numeric: false }], isActive: true, status: "PUBLISHED", version: 1, templateKey: null, sections: null });
        store.links.push({ id: 2, tenantId: T, templateId: 1, scopeType: "STAGE", scopeKey: "TECHNICAL", scopeId: null, isActive: true });
        const v2 = await as(() => svc.updateTemplate({ templateId: 1, criteria: [{ key: "a" }, { key: "b", required: false }], tenantId: T }));
        expect(v2).toMatchObject({ newVersion: true, version: 2, status: "PUBLISHED", templateKey: "legacy-1" });
        expect(store.templates.find((t) => t.id === 1)).toMatchObject({ status: "RETIRED", templateKey: "legacy-1" });
        const resolved = await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }));
        expect(resolved.id).toBe(v2.id);
        expect(resolved.criteria.map((c) => c.key)).toEqual(["a", "b"]);
    });
});

describe("links: the new scopes", () => {
    it("accept INTERVIEW_TYPE and PANEL_ROLE keyed by the closed vocabularies", async () => {
        const t = await as(() => svc.createTemplate({ name: "F", sections: SECTIONS, status: "PUBLISHED", tenantId: T }));
        const l1 = await as(() => svc.linkTemplate({ templateId: t.id, scopeType: "INTERVIEW_TYPE", scopeKey: "technical", tenantId: T }));
        expect(l1).toMatchObject({ scopeType: "INTERVIEW_TYPE", scopeKey: "TECHNICAL", scopeId: null });
        await expect(as(() => svc.linkTemplate({ templateId: t.id, scopeType: "PANEL_ROLE", scopeKey: "JANITOR", tenantId: T }))).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" } });
        expect((await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }))).id).toBe(t.id);
    });
});

describe("with the flag off", () => {
    beforeEach(() => {
        delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
    });

    it("refuses the form fields and the new scopes, and edits plain templates in place", async () => {
        await expect(as(() => svc.createTemplate({ name: "F", sections: SECTIONS, tenantId: T }))).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED" });
        const t = await as(() => svc.createTemplate({ name: "Plain", criteria: [{ key: "a" }], tenantId: T }));
        await expect(as(() => svc.linkTemplate({ templateId: t.id, scopeType: "INTERVIEW_TYPE", scopeKey: "TECHNICAL", tenantId: T }))).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" } });
        await as(() => svc.updateTemplate({ templateId: t.id, criteria: [{ key: "b" }], tenantId: T }));
        expect(store.templates).toHaveLength(1);
        expect(store.templates[0].criteria.map((c) => c.key)).toEqual(["b"]);
    });

    it("resolves the same object as before forms", async () => {
        const t = await as(() => svc.createTemplate({ name: "Plain", criteria: [{ key: "a" }], tenantId: T }));
        await as(() => svc.linkTemplate({ templateId: t.id, scopeType: "STAGE", scopeKey: "TECHNICAL", tenantId: T }));
        const resolved = await as(() => svc.resolveForInterview({ interviewId: 100, tenantId: T }));
        expect(resolved).toEqual({ id: t.id, name: "Plain", criteria: t.criteria, isActive: true, source: "TEMPLATE" });
    });

    it("never pins", async () => {
        expect(await as(() => tenantTransaction(db, async (tx) => await svc.pinEvaluationFormForInterview(tx, { tenantId: T, interviewId: 100 }), { tenantId: T }))).toBeNull();
    });
});

describe("pinEvaluationFormForInterview", () => {
    const pin = () => as(() => tenantTransaction(db, async (tx) => await svc.pinEvaluationFormForInterview(tx, { tenantId: T, interviewId: 100 }), { tenantId: T }));

    it("pins the resolved version once; later template changes never move it", async () => {
        const v1 = await as(() => svc.createTemplate({ name: "F", sections: SECTIONS, status: "PUBLISHED", tenantId: T }));
        await as(() => svc.linkTemplate({ templateId: v1.id, scopeType: "REQUISITION", scopeId: 5, tenantId: T }));
        expect(await pin()).toEqual({ templateId: v1.id, version: 1, pinned: true });
        expect(store.interviews[0]).toMatchObject({ formTemplateId: v1.id, formTemplateVersion: 1 });

        const v2 = await as(() => svc.updateTemplate({ templateId: v1.id, sections: SECTIONS.map((s) => ({ ...s, label: "Changed" })), status: "PUBLISHED", tenantId: T }));
        expect(v2.version).toBe(2);
        expect(await pin()).toEqual({ templateId: v1.id, version: 1, pinned: false });
        expect(store.interviews[0].formTemplateId).toBe(v1.id);
    });

    it("pins nothing when no form resolves", async () => {
        expect(await pin()).toBeNull();
        expect(store.interviews[0].formTemplateId).toBeNull();
    });

    it("pins an old criteria template too (old templates keep working)", async () => {
        store.templates.push({ id: 1, tenantId: T, name: "Old", criteria: [{ key: "a" }], isActive: true, status: "PUBLISHED", version: 1, templateKey: null, sections: null });
        store.links.push({ id: 2, tenantId: T, templateId: 1, scopeType: "JOB_FAMILY", scopeId: 9, scopeKey: null, isActive: true });
        expect(await pin()).toEqual({ templateId: 1, version: 1, pinned: true });
    });
});
