// src/services/scorecardTemplate.service.js
//
// Phase 7 / decision record §5.5–5.5b — tenant-configurable scorecard
// templates: CRUD, scope links, and the resolution + eligibility the write
// path consumes.
//
// The POLICY lives in lib/scorecardTemplates.js; this service owns reads and
// writes:
//   * templates are tenant rows; deactivation is SOFT (a template cited by
//     submitted scorecards must keep resolving — §5.5c's history is kept by
//     the Phase 3.4 lock, and this service never rewrites it)
//   * links attach a template to REQUISITION / STAGE / JOB_FAMILY; resolution
//     is most-specific-first
//   * resolveForInterview is the single lookup the scorecard write path (and
//     the tools) call — it loads the interview's requisition→position chain
//     and falls through to null (free-form scoring) when nothing matches,
//     so a tenant without templates keeps the pre-template flow intact
//
// Phase 3b — evaluation forms (flag evaluationForms; plan 7.4):
//   * a template may carry the full form (scale, sections of criteria with
//     anchors, weights, must-haves and question links, evidence rules, a
//     trained-interviewer flag, an interview type and a panel role);
//   * versions are rows sharing a templateKey, each DRAFT, PUBLISHED or
//     RETIRED. A PUBLISHED version is immutable: a content change makes the
//     next version, publishing it retires the previous one, and links follow
//     the key to the latest PUBLISHED version. Only PUBLISHED, active rows
//     resolve, so a draft never reaches an interview;
//   * links gain the INTERVIEW_TYPE and PANEL_ROLE scopes;
//   * pinEvaluationFormForInterview pins the resolved version on the interview
//     when it is scheduled, so a later template change never alters a form in
//     progress.
// With the flag off every function behaves as before: the new fields and
// scopes are refused with HR-RECRUITMENT-EVALUATION-FORMS-DISABLED, and a
// template update edits the row in place.

import crypto from "node:crypto";

import prisma from "../config/prisma.js";
import { scopedWhere, scopedData, withTenant } from "../lib/tenancy.js";
import { logAction } from "../utils/logs.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
    FORM_TEMPLATE_SCOPES,
    KEYED_SCOPES,
    TEMPLATE_SCOPES,
    checkRequiredCriteria,
    computeOverall,
    latestPublishedVersion,
    resolveTemplate,
    validateCriteria,
} from "../lib/scorecardTemplates.js";
import { PANEL_ROLES, TEMPLATE_STATUS, validateFormDefinition } from "../lib/evaluation-form.util.js";
import { employeeNamesById, nameOf } from "../lib/employee-names.util.js";

export class TemplateError extends Error {
    constructor(message, status = 400, details = undefined) {
        super(message);
        this.name = "TemplateError";
        this.status = status;
        this.details = details;
    }
}

const fail = (message, status, details) => new TemplateError(message, status, details);

// Phase 3b errors carry the code on the error too, like the surrounding
// recruitment services.
const failCode = (message, status, code, extra = {}) =>
    Object.assign(new TemplateError(message, status, { code, ...extra }), { code });

export const INTERVIEW_TYPE_KEYS = Object.freeze(["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "PANEL", "FINAL", "ONSITE", "VIDEO"]);

// The form fields a Phase 3b template adds; giving any of them needs the flag.
const FORM_FIELDS = Object.freeze(["templateKey", "interviewType", "panelRole", "scale", "sections", "evidenceRules", "requiresTrainedInterviewer", "status"]);

const formsEnabled = () => isRecruitmentFlagEnabled("evaluationForms");

const assertFormsEnabled = () => {
    if (!formsEnabled()) {
        throw failCode("Evaluation forms are not enabled", 503, "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED");
    }
};

const hasFormFields = (input) => FORM_FIELDS.some((f) => input[f] !== undefined);

/** The columns a form needs, for every read that resolves or pins one. */
export const FORM_TEMPLATE_SELECT = Object.freeze({
    id: true,
    name: true,
    description: true,
    criteria: true,
    isActive: true,
    status: true,
    templateKey: true,
    version: true,
    interviewType: true,
    panelRole: true,
    scale: true,
    sections: true,
    evidenceRules: true,
    requiresTrainedInterviewer: true,
    publishedAt: true,
    // Phase 7 (B10) — the author, shown by name on the form header.
    createdById: true,
});

const slug = (name) =>
    String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "form";

const optionalEnum = (value, allowed, field) => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const v = String(value).trim().toUpperCase();
    if (!allowed.includes(v)) {
        throw failCode(`${field} must be one of ${allowed.join(", ")}`, 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
    }
    return v;
};

/**
 * The form columns of a create or update, validated. `sections` replaces the
 * criteria list: the flattened criteria are kept in the legacy column so
 * readers that predate forms still see every key.
 */
function formColumns(input, base = {}) {
    const data = {};
    const interviewType = optionalEnum(input.interviewType, INTERVIEW_TYPE_KEYS, "interviewType");
    if (interviewType !== undefined) data.interviewType = interviewType;
    const panelRole = optionalEnum(input.panelRole, PANEL_ROLES, "panelRole");
    if (panelRole !== undefined) data.panelRole = panelRole;
    if (input.requiresTrainedInterviewer !== undefined) data.requiresTrainedInterviewer = input.requiresTrainedInterviewer === true;

    const touchesForm = input.sections !== undefined || input.scale !== undefined || input.evidenceRules !== undefined;
    if (touchesForm) {
        const sections = input.sections !== undefined ? input.sections : base.sections;
        if (sections === null || sections === undefined) {
            throw failCode("A form needs sections", 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
        }
        const verdict = validateFormDefinition({
            scale: input.scale !== undefined ? input.scale : base.scale,
            sections,
            evidenceRules: input.evidenceRules !== undefined ? input.evidenceRules : base.evidenceRules,
        });
        if (!verdict.ok) throw failCode(verdict.error, 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
        data.scale = verdict.form.scale;
        data.sections = verdict.form.sections;
        data.evidenceRules = verdict.form.evidenceRules;
        data.criteria = verdict.criteria;
    }
    return data;
}

const requestedStatus = (status) => optionalEnum(status, Object.values(TEMPLATE_STATUS), "status");

const toInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const AUDIT_MODULE = "Scorecard Templates";

// ── template CRUD ────────────────────────────────────────────────────────────

export const createTemplate = async ({ name, description, criteria, tenantId, actorId, ...form }) => {
    const cname = String(name ?? "").trim();
    if (!cname) throw fail("A template name is required", 400, { code: "HR-RECRUITMENT-TEMPLATE-NAME-REQUIRED" });
    if (hasFormFields(form)) return createFormTemplate({ name: cname, description, criteria, tenantId, actorId, ...form });
    const verdict = validateCriteria(criteria);
    if (!verdict.ok) throw fail(verdict.error, 400, { code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-INVALID" });

    const row = await prisma.scorecardTemplate.create({
        data: scopedData(tenantId, {
            name: cname,
            description: description ? String(description) : null,
            criteria: verdict.criteria,
            createdById: toInt(actorId),
        }),
    });
    await logAction({
        employeeId: toInt(actorId) ?? null,
        type: "CREATE",
        module: AUDIT_MODULE,
        result: "SUCCESS",
        notes: `Scorecard template "${row.name}" created (${verdict.criteria.length} criteria)`,
        tenantId: tenantId ?? null,
    });
    return row;
};

export const updateTemplate = async ({ templateId, name, description, criteria, tenantId, actorId, ...form }) => {
    if (hasFormFields(form)) assertFormsEnabled();
    const id = toInt(templateId);
    const existing = await prisma.scorecardTemplate.findFirst({
        where: scopedWhere(tenantId, { id: id ?? 0 }),
    });
    if (!existing) throw fail("Template not found", 404, "HR-RECRUITMENT-TEMPLATE-NOT-FOUND");
    if (formsEnabled()) {
        return updateVersionedTemplate({ existing, input: { name, description, criteria, ...form }, tenantId, actorId });
    }

    const data = {};
    if (name !== undefined) {
        const cname = String(name ?? "").trim();
        if (!cname) throw fail("A template name is required", 400, { code: "HR-RECRUITMENT-TEMPLATE-NAME-REQUIRED" });
        data.name = cname;
    }
    if (description !== undefined) data.description = description ? String(description) : null;
    if (criteria !== undefined) {
        const verdict = validateCriteria(criteria);
        if (!verdict.ok) throw fail(verdict.error, 400, { code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-INVALID" });
        data.criteria = verdict.criteria;
    }

    const row = await prisma.scorecardTemplate.update({ where: { id: existing.id }, data });
    await logAction({
        employeeId: toInt(actorId) ?? null,
        type: "UPDATE",
        module: AUDIT_MODULE,
        result: "SUCCESS",
        notes: `Scorecard template "${row.name}" updated`,
        tenantId: tenantId ?? null,
    });
    return row;
};

// ── Phase 3b: form templates, versions and publishing ───────────────────────

/** Later PUBLISHED versions retire the earlier ones: one live version per key. */
async function retireOtherPublished(client, tenantId, row) {
    if (!row.templateKey) return;
    await client.scorecardTemplate.updateMany({
        where: scopedWhere(tenantId, { templateKey: row.templateKey, status: TEMPLATE_STATUS.PUBLISHED, id: { not: row.id } }),
        data: { status: TEMPLATE_STATUS.RETIRED },
    });
}

const audit = (actorId, tenantId, type, notes) =>
    logAction({
        employeeId: toInt(actorId) ?? null,
        type,
        module: AUDIT_MODULE,
        result: "SUCCESS",
        notes,
        tenantId: tenantId ?? null,
    });

/**
 * Create a form template (flag evaluationForms). A form starts as DRAFT unless
 * status PUBLISHED is asked for; a template without sections may still use the
 * new fields (interview type, panel role, training flag) on its criteria list.
 */
export async function createFormTemplate({ name, description, criteria, tenantId, actorId, aiDrafted = false, ...input }) {
    assertFormsEnabled();
    const status = requestedStatus(input.status) ?? (input.sections !== undefined ? TEMPLATE_STATUS.DRAFT : TEMPLATE_STATUS.PUBLISHED);
    if (status === TEMPLATE_STATUS.RETIRED) {
        throw failCode("A template cannot be created RETIRED", 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
    }
    const data = formColumns(input);
    if (!data.criteria) {
        const verdict = validateCriteria(criteria);
        if (!verdict.ok) throw fail(verdict.error, 400, { code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-INVALID" });
        data.criteria = verdict.criteria;
    }
    let templateKey = typeof input.templateKey === "string" && input.templateKey.trim() ? input.templateKey.trim() : null;
    if (templateKey) {
        const clash = await prisma.scorecardTemplate.findFirst({ where: scopedWhere(tenantId, { templateKey }), select: { id: true } });
        if (clash) throw failCode("A template with this key exists; update it to make a new version", 409, "HR-RECRUITMENT-TEMPLATE-KEY-EXISTS");
    } else {
        templateKey = `${slug(name)}-${crypto.randomBytes(3).toString("hex")}`;
    }
    const row = await prisma.scorecardTemplate.create({
        data: scopedData(tenantId, {
            name,
            description: description ? String(description) : null,
            ...data,
            templateKey,
            version: 1,
            status,
            publishedAt: status === TEMPLATE_STATUS.PUBLISHED ? new Date() : null,
            createdById: toInt(actorId),
        }),
    });
    await audit(actorId, tenantId, "CREATE", `Evaluation form "${row.name}" v1 created (${status}${aiDrafted ? ", AI drafted" : ""})`);
    return row;
}

const CONTENT_FIELDS = Object.freeze(["name", "description", "criteria", "sections", "scale", "evidenceRules", "interviewType", "panelRole", "requiresTrainedInterviewer"]);

/** The column changes an update asks for (validated), without status. */
function contentChanges(existing, input) {
    const data = formColumns(input, existing);
    if (input.name !== undefined) {
        const cname = String(input.name ?? "").trim();
        if (!cname) throw fail("A template name is required", 400, { code: "HR-RECRUITMENT-TEMPLATE-NAME-REQUIRED" });
        data.name = cname;
    }
    if (input.description !== undefined) data.description = input.description ? String(input.description) : null;
    if (input.criteria !== undefined && input.sections === undefined) {
        // A sectioned form is edited through its sections; its criteria column
        // is derived from them.
        if (Array.isArray(existing.sections) && existing.sections.length) {
            throw failCode("This template is a form; edit its sections", 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
        }
        const verdict = validateCriteria(input.criteria);
        if (!verdict.ok) throw fail(verdict.error, 400, { code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-INVALID" });
        data.criteria = verdict.criteria;
    }
    return data;
}

/** Validate a version for publishing (a sectioned form must pass the full validator). */
function assertPublishable(row) {
    if (Array.isArray(row.sections) && row.sections.length) {
        const verdict = validateFormDefinition({ scale: row.scale, sections: row.sections, evidenceRules: row.evidenceRules });
        if (!verdict.ok) throw failCode(verdict.error, 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
    }
}

/**
 * The flag-on update: DRAFT versions change in place; a PUBLISHED version is
 * immutable, so a content change makes the next version (DRAFT for a form,
 * PUBLISHED for a plain criteria template so its edits keep taking effect,
 * unless a status is given). status PUBLISHED publishes; RETIRED retires.
 */
async function updateVersionedTemplate({ existing, input, tenantId, actorId }) {
    const status = requestedStatus(input.status);
    if (existing.status === TEMPLATE_STATUS.RETIRED) {
        throw failCode("A retired template cannot change", 409, "HR-RECRUITMENT-TEMPLATE-RETIRED");
    }
    const data = contentChanges(existing, input);
    const changed = CONTENT_FIELDS.some((f) => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(existing[f] ?? null));

    if (existing.status === TEMPLATE_STATUS.PUBLISHED && !changed) {
        if (status !== TEMPLATE_STATUS.RETIRED) return existing;
        const row = await prisma.scorecardTemplate.update({ where: { id: existing.id }, data: { status: TEMPLATE_STATUS.RETIRED } });
        await audit(actorId, tenantId, "UPDATE", `Evaluation form "${row.name}" v${row.version} retired`);
        return row;
    }

    if (existing.status === TEMPLATE_STATUS.DRAFT) {
        const next = { ...existing, ...data };
        if (status === TEMPLATE_STATUS.PUBLISHED) assertPublishable(next);
        const row = await prisma.scorecardTemplate.update({
            where: { id: existing.id },
            data: {
                ...data,
                ...(status ? { status } : {}),
                ...(status === TEMPLATE_STATUS.PUBLISHED ? { publishedAt: new Date() } : {}),
            },
        });
        if (status === TEMPLATE_STATUS.PUBLISHED) await retireOtherPublished(prisma, tenantId, row);
        await audit(actorId, tenantId, "UPDATE", `Evaluation form "${row.name}" v${row.version} ${status === TEMPLATE_STATUS.PUBLISHED ? "published" : "updated"}`);
        return row;
    }

    // PUBLISHED and changed: the next version.
    const templateKey = existing.templateKey ?? `legacy-${existing.id}`;
    if (!existing.templateKey) {
        await prisma.scorecardTemplate.update({ where: { id: existing.id }, data: { templateKey } });
    }
    const latest = await prisma.scorecardTemplate.findFirst({
        where: scopedWhere(tenantId, { templateKey }),
        orderBy: { version: "desc" },
        select: { version: true },
    });
    const isForm = Array.isArray(data.sections ?? existing.sections) && (data.sections ?? existing.sections).length > 0;
    const nextStatus = status ?? (isForm ? TEMPLATE_STATUS.DRAFT : TEMPLATE_STATUS.PUBLISHED);
    if (nextStatus === TEMPLATE_STATUS.RETIRED) {
        throw failCode("Retire a version without changing it", 400, "HR-RECRUITMENT-TEMPLATE-FORM-INVALID");
    }
    const draft = {
        name: existing.name,
        description: existing.description ?? null,
        criteria: existing.criteria,
        interviewType: existing.interviewType ?? null,
        panelRole: existing.panelRole ?? null,
        scale: existing.scale ?? undefined,
        sections: existing.sections ?? undefined,
        evidenceRules: existing.evidenceRules ?? undefined,
        requiresTrainedInterviewer: existing.requiresTrainedInterviewer === true,
        ...data,
    };
    if (nextStatus === TEMPLATE_STATUS.PUBLISHED) assertPublishable(draft);
    const row = await prisma.scorecardTemplate.create({
        data: scopedData(tenantId, {
            ...draft,
            templateKey,
            version: Math.max(Number(latest?.version ?? 0), Number(existing.version ?? 1)) + 1,
            status: nextStatus,
            publishedAt: nextStatus === TEMPLATE_STATUS.PUBLISHED ? new Date() : null,
            isActive: existing.isActive !== false,
            createdById: toInt(actorId),
        }),
    });
    if (nextStatus === TEMPLATE_STATUS.PUBLISHED) await retireOtherPublished(prisma, tenantId, row);
    await audit(actorId, tenantId, "CREATE", `Evaluation form "${row.name}" v${row.version} created from v${existing.version ?? 1} (${nextStatus})`);
    return { ...row, newVersion: true, previousVersionId: existing.id };
}

/**
 * SOFT deactivation (§5.5c-adjacent): a template cited by submitted scorecards
 * must keep resolving, so it is flagged, never hard-deleted while links or
 * scorecards point at it. A template with no links may be hard-deleted.
 */
export const deactivateTemplate = async ({ templateId, tenantId, actorId }) => {
    const id = toInt(templateId);
    const existing = await prisma.scorecardTemplate.findFirst({
        where: scopedWhere(tenantId, { id: id ?? 0 }),
        select: { id: true, name: true, _count: { select: { links: true } } },
    });
    if (!existing) throw fail("Template not found", 404, "HR-RECRUITMENT-TEMPLATE-NOT-FOUND");

    if (existing._count.links === 0) {
        await prisma.scorecardTemplate.delete({ where: { id: existing.id } });
        return { id: existing.id, deleted: true };
    }
    await prisma.scorecardTemplate.update({ where: { id: existing.id }, data: { isActive: false } });
    await logAction({
        employeeId: toInt(actorId) ?? null,
        type: "UPDATE",
        module: AUDIT_MODULE,
        result: "SUCCESS",
        notes: `Scorecard template "${existing.name}" deactivated (links remain)`,
        tenantId: tenantId ?? null,
    });
    return { id: existing.id, deleted: false, deactivated: true };
};

// Phase 7 (B10) — every template and link carries its author's display name
// (createdByName next to createdById), from one lookup for the whole list.
export const listTemplates = async ({ tenantId, includeInactive = false }) => {
    const rows = await prisma.scorecardTemplate.findMany({
        where: scopedWhere(tenantId, includeInactive ? {} : { isActive: true }),
        orderBy: { id: "asc" },
        include: { links: { where: { isActive: true } } },
    });
    const names = await employeeNamesById(prisma, tenantId, rows.flatMap((t) => [
        t.createdById,
        ...(Array.isArray(t.links) ? t.links.map((l) => l.createdById) : []),
    ]));
    return rows.map((t) => ({
        ...t,
        createdByName: nameOf(names, t.createdById),
        ...(Array.isArray(t.links) ? { links: t.links.map((l) => ({ ...l, createdByName: nameOf(names, l.createdById) })) } : {}),
    }));
};

// ── links ────────────────────────────────────────────────────────────────────

export const linkTemplate = async ({ templateId, scopeType, scopeId, scopeKey, tenantId, actorId }) => {
    const tid = toInt(templateId);
    const scope = String(scopeType ?? "").trim().toUpperCase();
    // Phase 3b — INTERVIEW_TYPE and PANEL_ROLE exist only with the flag on.
    const scopes = formsEnabled() ? FORM_TEMPLATE_SCOPES : TEMPLATE_SCOPES;
    if (!scopes.includes(scope)) {
        throw fail(`scopeType must be one of ${scopes.join(", ")}`, 400, { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" });
    }
    const template = await prisma.scorecardTemplate.findFirst({
        where: scopedWhere(tenantId, { id: tid ?? 0 }),
        select: { id: true },
    });
    if (!template) throw fail("Template not found", 404, "HR-RECRUITMENT-TEMPLATE-NOT-FOUND");

    const sid = toInt(scopeId);
    const skey = typeof scopeKey === "string" && scopeKey.trim() ? scopeKey.trim() : null;
    // The same pairing rule as the migration's CHECK, enforced with a better error.
    if ((scope === "REQUISITION" || scope === "JOB_FAMILY") && !sid) {
        throw fail(`${scope} links need a scopeId`, 400, { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" });
    }
    if (scope === "STAGE" && !skey) {
        throw fail("STAGE links need a scopeKey (the interview type)", 400, { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" });
    }
    if (scope === "INTERVIEW_TYPE" && !INTERVIEW_TYPE_KEYS.includes(String(skey ?? "").toUpperCase())) {
        throw fail(`INTERVIEW_TYPE links need a scopeKey: ${INTERVIEW_TYPE_KEYS.join(", ")}`, 400, { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" });
    }
    if (scope === "PANEL_ROLE" && !PANEL_ROLES.includes(String(skey ?? "").toUpperCase())) {
        throw fail(`PANEL_ROLE links need a scopeKey: ${PANEL_ROLES.join(", ")}`, 400, { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" });
    }
    const keyed = KEYED_SCOPES.includes(scope) && scope !== "STAGE";
    const linkKey = keyed ? String(skey).toUpperCase() : skey;

    const address = { templateId: template.id, scopeType: scope, scopeId: keyed ? null : sid, scopeKey: linkKey };
    // Find-or-create, not upsert: every link has one of scopeId / scopeKey
    // NULL (the addressing CHECK), Prisma refuses a NULL member in a
    // compound-unique where, and Postgres treats NULLs as distinct in the
    // unique index anyway. A concurrent double link is harmless: resolution
    // reads links as a set.
    const existing = await prisma.scorecardTemplateLink.findFirst({ where: scopedWhere(tenantId, address) });
    if (existing) {
        return existing.isActive
            ? existing
            : prisma.scorecardTemplateLink.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    return prisma.scorecardTemplateLink.create({ data: scopedData(tenantId, { ...address, createdById: toInt(actorId) }) });
};

export const unlinkTemplate = async ({ linkId, tenantId }) => {
    const id = toInt(linkId);
    const where = scopedWhere(tenantId, { id: id ?? 0 });
    const before = await prisma.scorecardTemplateLink.findFirst({ where, select: { id: true } });
    if (!before) throw fail("Template link not found", 404, "HR-RECRUITMENT-TEMPLATE-LINK-NOT-FOUND");
    await prisma.scorecardTemplateLink.deleteMany({ where });
    return { id: before.id, deleted: true };
};

// ── resolution + eligibility (the write path's entry points) ─────────────────

/**
 * The template that governs ONE interview, or null (free-form scoring).
 * Loads the interview's requisition→position chain itself so callers cannot
 * resolve with a half-context.
 */
/**
 * FR-07 residue — the screening-scorecard half of the same lookup. Resolves the
 * template for an APPLICATION's requisition (REQUISITION → STAGE → JOB_FAMILY,
 * the identical order interviews use) so a screening scorecard is judged against
 * the same template the tenant configured, never a parallel one.
 *
 * Returns null when nothing is linked (→ free-form criteria, pre-residue
 * behavior) — a tenant that never configures templates sees no change.
 */
export const resolveForApplication = async ({ applicationId, tenantId }) => {
    const id = toInt(applicationId);
    if (!id) return null;
    const application = await prisma.application.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: { jobRequisition: { select: { id: true, positionId: true } } },
    });
    if (!application) return null;

    const ctx = {
        jobRequisitionId: application.jobRequisition?.id ?? null,
        positionId: application.jobRequisition?.positionId ?? null,
        // The STAGE rung is interview-type keyed and a screening happens before
        // any interview type exists, so it deliberately cannot match here: a
        // screening scorecard resolves by REQUISITION → JOB_FAMILY only. Passing
        // null (rather than a guess) keeps that scoping explicit and testable.
        interviewType: null,
    };
    const template = await resolveFromLinks(prisma, tenantId, ctx);
    return template ? { ...legacyShape(template), source: "TEMPLATE" } : null;
};

// The template columns the pre-form resolution returned, kept identical so a
// caller that never asked for forms sees the same object.
const LEGACY_TEMPLATE_SELECT = Object.freeze({
    id: true, name: true, criteria: true, isActive: true, status: true, templateKey: true, version: true, interviewType: true, panelRole: true,
});
const legacyShape = (t) => ({ id: t.id, name: t.name, criteria: t.criteria, isActive: t.isActive });

/**
 * Resolve over the tenant's active links: only active PUBLISHED versions
 * count (a row from before versions has no status and counts as published),
 * and a link follows its key to the latest PUBLISHED version.
 */
async function resolveFromLinks(client, tenantId, ctx, select = LEGACY_TEMPLATE_SELECT) {
    const links = await client.scorecardTemplateLink.findMany({
        where: scopedWhere(tenantId, { isActive: true }),
        include: { template: { select } },
    });
    const keys = [...new Set(links.map((l) => l.template?.templateKey).filter(Boolean))];
    const published = keys.length
        ? await client.scorecardTemplate.findMany({
            where: scopedWhere(tenantId, { templateKey: { in: keys }, status: TEMPLATE_STATUS.PUBLISHED, isActive: true }),
            select,
        })
        : [];
    const live = (t) => t && t.isActive && (t.status ?? TEMPLATE_STATUS.PUBLISHED) === TEMPLATE_STATUS.PUBLISHED;
    const candidates = [];
    for (const l of links) {
        const template = l.template?.templateKey ? latestPublishedVersion(l.template, published) : l.template;
        if (live(template)) candidates.push({ scopeType: l.scopeType, scopeId: l.scopeId, scopeKey: l.scopeKey, template });
    }
    return resolveTemplate(candidates, ctx);
}

const INTERVIEW_CONTEXT_SELECT = Object.freeze({
    interviewType: true,
    application: {
        select: { stage: true, jobRequisition: { select: { id: true, positionId: true } } },
    },
});

const contextOf = (interview, panelRole = null) => ({
    jobRequisitionId: interview.application?.jobRequisition?.id ?? null,
    positionId: interview.application?.jobRequisition?.positionId ?? null,
    interviewType: interview.interviewType ?? null,
    stage: interview.application?.stage ?? null,
    panelRole: panelRole ? String(panelRole).toUpperCase() : null,
});

export const resolveForInterview = async ({ interviewId, tenantId, panelRole = null }) => {
    const id = toInt(interviewId);
    if (!id) return null;
    const interview = await prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: INTERVIEW_CONTEXT_SELECT,
    });
    if (!interview) return null;

    // Phase 3b — with the flag on the whole form travels (sections, scale,
    // version) and the panel role narrows the rung; with it off the object is
    // the one the pre-form resolution returned.
    if (formsEnabled()) {
        const template = await resolveFromLinks(prisma, tenantId, contextOf(interview, panelRole), FORM_TEMPLATE_SELECT);
        return template ? { ...template, source: "TEMPLATE" } : null;
    }
    const template = await resolveFromLinks(prisma, tenantId, { ...contextOf(interview), stage: null });
    return template ? { ...legacyShape(template), source: "TEMPLATE" } : null;
};

/**
 * Phase 3b — pin the evaluation form on an interview: resolve the template for
 * it (requisition, interview type, stage, job family) and store its id and
 * version. Runs inside the caller's tenant transaction (the scheduler calls it
 * as part of scheduleInterview). An interview already pinned keeps its form,
 * so rescheduling or a later template change never alters a form in progress.
 * No-op (null) with the flag off or when nothing resolves.
 *
 * @param {object} tx  tenant transaction client
 * @returns {Promise<{ templateId: number, version: number, pinned: boolean }|null>}
 */
export async function pinEvaluationFormForInterview(tx, { tenantId, interviewId } = {}) {
    const id = toInt(interviewId);
    if (!formsEnabled() || !tenantId || !id) return null;
    const interview = await tx.interview.findFirst({
        where: withTenant(tenantId, { id }),
        select: { ...INTERVIEW_CONTEXT_SELECT, formTemplateId: true, formTemplateVersion: true },
    });
    if (!interview) return null;
    if (interview.formTemplateId) {
        return { templateId: interview.formTemplateId, version: interview.formTemplateVersion ?? 1, pinned: false };
    }
    const template = await resolveFromLinks(tx, tenantId, contextOf(interview), FORM_TEMPLATE_SELECT);
    if (!template) return null;
    const version = template.version ?? 1;
    // Guarded: a concurrent pin wins once, the other keeps what it finds.
    const claim = await tx.interview.updateMany({
        where: withTenant(tenantId, { id, formTemplateId: null }),
        data: { formTemplateId: template.id, formTemplateVersion: version },
    });
    return { templateId: template.id, version, pinned: claim.count > 0 };
}

/**
 * §5.5b — validate a submission against a template BEFORE it is written.
 * Returns the normalized overall (weighted when the template is) or null when
 * there is no template (free-form scoring is untouched).
 */
export const validateSubmission = ({ template, scores }) => {
    if (!template) return { overall: null, weighted: false };
    const { missing, unknown } = checkRequiredCriteria(template.criteria ?? [], scores ?? {});
    if (missing.length) {
        throw fail("Required scorecard criteria are missing", 400, {
            code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-MISSING",
            missingCriteria: missing,
        });
    }
    if (unknown.length) {
        throw fail("Submission contains criteria the template does not define", 400, {
            code: "HR-RECRUITMENT-TEMPLATE-CRITERIA-UNKNOWN",
            unknownCriteria: unknown,
        });
    }
    const result = computeOverall(template.criteria ?? [], scores ?? {});
    return result;
};
