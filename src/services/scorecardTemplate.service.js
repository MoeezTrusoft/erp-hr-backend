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

import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { logAction } from "../utils/logs.js";
import {
    TEMPLATE_SCOPES,
    checkRequiredCriteria,
    computeOverall,
    resolveTemplate,
    validateCriteria,
} from "../lib/scorecardTemplates.js";

export class TemplateError extends Error {
    constructor(message, status = 400, details = undefined) {
        super(message);
        this.name = "TemplateError";
        this.status = status;
        this.details = details;
    }
}

const fail = (message, status, details) => new TemplateError(message, status, details);

const toInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const AUDIT_MODULE = "Scorecard Templates";

// ── template CRUD ────────────────────────────────────────────────────────────

export const createTemplate = async ({ name, description, criteria, tenantId, actorId }) => {
    const cname = String(name ?? "").trim();
    if (!cname) throw fail("A template name is required", 400, { code: "HR-RECRUITMENT-TEMPLATE-NAME-REQUIRED" });
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

export const updateTemplate = async ({ templateId, name, description, criteria, tenantId, actorId }) => {
    const id = toInt(templateId);
    const existing = await prisma.scorecardTemplate.findFirst({
        where: scopedWhere(tenantId, { id: id ?? 0 }),
    });
    if (!existing) throw fail("Template not found", 404, "HR-RECRUITMENT-TEMPLATE-NOT-FOUND");

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

export const listTemplates = async ({ tenantId, includeInactive = false }) => {
    return prisma.scorecardTemplate.findMany({
        where: scopedWhere(tenantId, includeInactive ? {} : { isActive: true }),
        orderBy: { id: "asc" },
        include: { links: { where: { isActive: true } } },
    });
};

// ── links ────────────────────────────────────────────────────────────────────

export const linkTemplate = async ({ templateId, scopeType, scopeId, scopeKey, tenantId, actorId }) => {
    const tid = toInt(templateId);
    const scope = String(scopeType ?? "").trim().toUpperCase();
    if (!TEMPLATE_SCOPES.includes(scope)) {
        throw fail(`scopeType must be one of ${TEMPLATE_SCOPES.join(", ")}`, 400, { code: "HR-RECRUITMENT-TEMPLATE-SCOPE-INVALID" });
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

    const row = await prisma.scorecardTemplateLink.upsert({
        where: {
            templateId_scopeType_scopeId_scopeKey: {
                templateId: template.id,
                scopeType: scope,
                scopeId: sid,
                scopeKey: skey,
            },
        },
        create: scopedData(tenantId, {
            templateId: template.id,
            scopeType: scope,
            scopeId: sid,
            scopeKey: skey,
            createdById: toInt(actorId),
        }),
        update: { isActive: true },
    });
    return row;
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

    const links = await prisma.scorecardTemplateLink.findMany({
        where: scopedWhere(tenantId, { isActive: true }),
        include: { template: { select: { id: true, name: true, criteria: true, isActive: true } } },
    });
    const ctx = {
        jobRequisitionId: application.jobRequisition?.id ?? null,
        positionId: application.jobRequisition?.positionId ?? null,
        // The STAGE rung is interview-type keyed and a screening happens before
        // any interview type exists, so it deliberately cannot match here: a
        // screening scorecard resolves by REQUISITION → JOB_FAMILY only. Passing
        // null (rather than a guess) keeps that scoping explicit and testable.
        interviewType: null,
    };
    const template = resolveTemplate(
        links.filter((l) => l.template.isActive).map((l) => ({ scopeType: l.scopeType, scopeId: l.scopeId, scopeKey: l.scopeKey, template: l.template })),
        ctx,
    );
    return template ? { ...template, source: "TEMPLATE" } : null;
};

export const resolveForInterview = async ({ interviewId, tenantId }) => {
    const id = toInt(interviewId);
    if (!id) return null;
    const interview = await prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: {
            interviewType: true,
            application: {
                select: { jobRequisition: { select: { id: true, positionId: true } } },
            },
        },
    });
    if (!interview) return null;

    const links = await prisma.scorecardTemplateLink.findMany({
        where: scopedWhere(tenantId, { isActive: true }),
        include: { template: { select: { id: true, name: true, criteria: true, isActive: true } } },
    });
    const ctx = {
        jobRequisitionId: interview.application?.jobRequisition?.id ?? null,
        positionId: interview.application?.jobRequisition?.positionId ?? null,
        interviewType: interview.interviewType ?? null,
    };
    const template = resolveTemplate(
        links.filter((l) => l.template.isActive).map((l) => ({ scopeType: l.scopeType, scopeId: l.scopeId, scopeKey: l.scopeKey, template: l.template })),
        ctx,
    );
    return template ? { ...template, source: "TEMPLATE" } : null;
};

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
