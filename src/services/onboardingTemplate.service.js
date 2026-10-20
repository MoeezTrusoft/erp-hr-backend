// src/services/onboardingTemplate.service.js — FR-13 residue.
//
// Tenant-configurable onboarding checklist templates: the write path, the read
// path, and the PROVISION-TIME resolver the accepted-offer handoff calls.
//
// Rules that matter:
//   * every query is tenant-scoped (fail-closed) — RLS sits under it, so a
//     cross-tenant id is NOT-FOUND rather than a 403 that confirms existence
//   * the task list is validated by the pure module before it is stored, so an
//     invalid template cannot exist to be resolved later
//   * marking a template default CLEARS the previous default in the same
//     transaction — "the tenant's default" is a single row by construction, not
//     by convention, because the resolver has to pick exactly one
//   * deactivating the default leaves the tenant with no template, which the
//     resolver reads as "use the baseline" — never as "no checklist"
//   * Recruitment Phase 4 — a template may also carry the orientation and
//     compliance `sessions` the handoff creates (lib/onboarding-sessions.util.js
//     owns the shape). Omitted on a write leaves the stored list as it is;
//     null clears it (the baseline set applies); a list, even an empty one,
//     is validated and stored.
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { resolveChecklistTasks, validateTemplateTasks } from "../lib/onboardingTemplates.js";
import { resolveSessionPlan, validateTemplateSessions } from "../lib/onboarding-sessions.util.js";

const fail = (message, status, code) =>
    Object.assign(new Error(message), { status, code: code ?? "HR-ONBOARDING-TEMPLATE" });

const toInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/** The tenant's active default template row, or null (→ baseline). */
export const findDefaultTemplate = async (db, tenantId) =>
    db.onboardingChecklistTemplate.findFirst({
        where: scopedWhere(tenantId, { isActive: true, isDefault: true }),
        orderBy: { id: "asc" },
    });

/**
 * The PROVISION-TIME answer: which task definitions should this hire's checklist
 * be seeded with? Runs inside the caller's transaction so the template read and
 * the checklist write see one consistent state.
 *
 * @returns {Promise<{tasks: object[], source: string, templateId: number|null}>}
 */
export const resolveTasksForProvisioning = async (db, tenantId) => {
    const template = await findDefaultTemplate(db, tenantId);
    return resolveChecklistTasks(template);
};

/**
 * Phase 4 — the sessions a provisioned hire gets: the default template's
 * validated `sessions`, else the baseline. Runs on the caller's transaction.
 *
 * @returns {Promise<{sessions: object[], source: string, templateId: number|null}>}
 */
export const resolveSessionsForProvisioning = async (db, tenantId) => {
    const template = await findDefaultTemplate(db, tenantId);
    return resolveSessionPlan(template);
};

// undefined = leave the column alone; null = clear (baseline); a list = store.
function sessionsColumn(sessions) {
    if (sessions === undefined) return {};
    if (sessions === null) return { sessions: Prisma.DbNull };
    const verdict = validateTemplateSessions(sessions);
    if (!verdict.ok) {
        throw Object.assign(fail(`Invalid onboarding template: ${verdict.error}`, 422, "HR-ONBOARDING-TEMPLATE-INVALID"), {
            details: { reason: verdict.error },
        });
    }
    return { sessions: verdict.sessions };
}

/** All templates for the tenant (newest first), optionally including inactive. */
export const listTemplates = async ({ tenantId, includeInactive = false } = {}) => {
    if (!tenantId) throw fail("Tenant context is required", 400);
    return prisma.onboardingChecklistTemplate.findMany({
        where: scopedWhere(tenantId, includeInactive ? {} : { isActive: true }),
        orderBy: [{ isDefault: "desc" }, { id: "asc" }],
    });
};

/**
 * Create or update a template by name (idempotent upsert on tenant+name), and
 * optionally make it the tenant's default.
 */
export const upsertTemplate = async ({ tenantId, name, description = null, tasks, sessions, makeDefault = false, actorId = null } = {}) => {
    if (!tenantId) throw fail("Tenant context is required", 400);
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) throw fail("A template name is required", 400, "HR-ONBOARDING-TEMPLATE-NAME-REQUIRED");

    const verdict = validateTemplateTasks(tasks);
    if (!verdict.ok) {
        throw fail("Invalid onboarding template", 422, "HR-ONBOARDING-TEMPLATE-INVALID");
    }
    const sessionData = sessionsColumn(sessions);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const existing = await tx.onboardingChecklistTemplate.findFirst({
                where: scopedWhere(tenantId, { name: cleanName }),
                select: { id: true },
            });

            // One default per tenant: clear the incumbent BEFORE promoting the new
            // one, in the same transaction, so the resolver can never see two.
            if (makeDefault) {
                await tx.onboardingChecklistTemplate.updateMany({
                    where: scopedWhere(tenantId, { isDefault: true }),
                    data: { isDefault: false },
                });
            }

            if (existing) {
                return tx.onboardingChecklistTemplate.update({
                    where: { id: existing.id },
                    data: {
                        description,
                        tasks: verdict.tasks,
                        ...sessionData,
                        ...(makeDefault ? { isDefault: true } : {}),
                        isActive: true,
                    },
                });
            }

            return tx.onboardingChecklistTemplate.create({
                data: scopedData(tenantId, {
                    name: cleanName,
                    description,
                    tasks: verdict.tasks,
                    ...sessionData,
                    isActive: true,
                    // The FIRST template a tenant creates becomes the default: an
                    // operator who authored one obviously means it to be used.
                    isDefault: makeDefault || (await noTemplatesYet(tx, tenantId)),
                    createdById: actorId ?? null,
                }),
            });
        },
        { tenantId },
    );
};

const noTemplatesYet = async (tx, tenantId) => {
    const count = await tx.onboardingChecklistTemplate.count({ where: scopedWhere(tenantId, {}) });
    return count === 0;
};

/** Deactivate a template. A deactivated default leaves the tenant on the baseline. */
export const deactivateTemplate = async ({ tenantId, templateId } = {}) => {
    if (!tenantId) throw fail("Tenant context is required", 400);
    const id = toInt(templateId);
    if (!id) throw fail("Template not found", 404, "HR-ONBOARDING-TEMPLATE-NOT-FOUND");

    const row = await prisma.onboardingChecklistTemplate.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: { id: true },
    });
    if (!row) throw fail("Template not found", 404, "HR-ONBOARDING-TEMPLATE-NOT-FOUND");

    return prisma.onboardingChecklistTemplate.update({
        where: { id },
        data: { isActive: false, isDefault: false },
    });
};
