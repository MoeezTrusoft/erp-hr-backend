// src/services/recruitment-freeze.service.js
//
// Phase 4 / decision record §2.7 — hiring freezes.
//
// A freeze is a CONTROL, so the design choices here are all about not quietly
// losing it:
//
//   * It blocks SUBMISSION and PUBLICATION, not drafting. HR can keep preparing
//     requisitions during a freeze and publish them the day it lifts; a freeze
//     that also blocked drafting would just move the work into email.
//   * A department-level freeze must name its department (enforced here AND by a
//     CHECK constraint), because the failure mode of a mis-scoped freeze is a
//     company-wide stop that nobody asked for.
//   * Lifting is a state change with who/when/why, never a delete, so the record
//     of the freeze outlives it.
//
// The active-freeze lookup is deliberately one query returning at most one row:
// callers ask "is this requisition frozen?" and get a yes/no plus the reason to
// show, rather than having to interpret a list of overlapping freezes.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

export const FREEZE_SCOPES = Object.freeze(["COMPANY", "BUSINESS_UNIT"]);

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const toId = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const requireReason = (reason, code) => {
    const text = String(reason ?? "").trim();
    if (!text) throw fail("A reason is required", 422, code);
    return text;
};

/**
 * The ACTIVE freeze that applies to a requisition, or null.
 *
 * One query: a company-wide freeze OR a department freeze naming that
 * requisition's business unit. A department-less requisition is only covered by a
 * company-wide freeze — it cannot be matched by a department freeze, which is the
 * conservative reading (the alternative would let an unscoped requisition slip
 * past a department freeze it might belong to).
 */
export const activeFreezeFor = async (tenantId, departmentId = null) => {
    const dept = toId(departmentId);
    const arms = [{ scope: "COMPANY" }];
    if (dept) arms.push({ scope: "BUSINESS_UNIT", departmentId: dept });

    return prisma.recruitmentHiringFreeze.findFirst({
        where: scopedWhere(tenantId, { isActive: true, OR: arms }),
        orderBy: { id: "desc" },
    });
};

/**
 * Throw 409 when the requisition is frozen for this operation.
 *
 * `action` is the verb the caller attempted ("submit" | "publish") so the message
 * says what was refused, and the freeze's own reason and scope travel in
 * `details` so the UI can name the freeze instead of showing a bare conflict.
 */
export const assertNotHiringFrozen = async (tenantId, requisition, action) => {
    const freeze = await activeFreezeFor(tenantId, requisition?.departmentId);
    if (!freeze) return null;
    throw fail(
        `A hiring freeze is in effect${freeze.reason ? `: ${freeze.reason}` : ""} — ${action} is blocked`,
        409,
        "HR-RECRUITMENT-HIRING-FREEZE",
        {
            freezeId: freeze.id,
            scope: freeze.scope,
            departmentId: freeze.departmentId ?? null,
            reason: freeze.reason,
            action,
        },
    );
};

export const setHiringFreeze = async (tenantId, { scope, departmentId, reason, createdById } = {}) => {
    const normalizedScope = String(scope ?? "COMPANY").trim().toUpperCase();
    if (!FREEZE_SCOPES.includes(normalizedScope)) {
        throw fail(`scope must be one of: ${FREEZE_SCOPES.join(", ")}`, 422, "HR-RECRUITMENT-FREEZE-SCOPE-INVALID");
    }
    const dept = normalizedScope === "BUSINESS_UNIT" ? toId(departmentId) : null;
    if (normalizedScope === "BUSINESS_UNIT" && !dept) {
        throw fail(
            "A business-unit freeze must name the business unit",
            422,
            "HR-RECRUITMENT-FREEZE-DEPARTMENT-REQUIRED",
        );
    }
    const text = requireReason(reason, "HR-RECRUITMENT-FREEZE-REASON-REQUIRED");

    // Idempotent on purpose: re-issuing an identical freeze is a no-op rather than
    // a second active row, so the active-freeze lookup stays unambiguous and the
    // audit trail does not fill with duplicates of the same decision.
    const existing = await prisma.recruitmentHiringFreeze.findFirst({
        where: scopedWhere(tenantId, {
            isActive: true,
            scope: normalizedScope,
            departmentId: dept,
        }),
    });
    if (existing) return existing;

    return prisma.recruitmentHiringFreeze.create({
        data: scopedData(tenantId, {
            scope: normalizedScope,
            departmentId: dept,
            reason: text,
            isActive: true,
            createdById: toId(createdById),
        }),
    });
};

export const liftHiringFreeze = async (tenantId, freezeId, { reason, liftedById } = {}) => {
    const id = toId(freezeId);
    if (!id) throw fail("Hiring freeze not found", 404, "HR-RECRUITMENT-FREEZE-NOT-FOUND");

    // Tenant-scoped pre-read so a cross-tenant id is not-found rather than a
    // successful lift of another tenant's control.
    const existing = await prisma.recruitmentHiringFreeze.findFirst({
        where: scopedWhere(tenantId, { id }),
    });
    if (!existing) throw fail("Hiring freeze not found", 404, "HR-RECRUITMENT-FREEZE-NOT-FOUND");
    if (!existing.isActive) throw fail("Hiring freeze is already lifted", 409, "HR-RECRUITMENT-FREEZE-ALREADY-LIFTED");

    const text = requireReason(reason, "HR-RECRUITMENT-FREEZE-LIFT-REASON-REQUIRED");
    return prisma.recruitmentHiringFreeze.update({
        where: { id },
        data: {
            isActive: false,
            liftedAt: new Date(),
            liftedById: toId(liftedById),
            liftReason: text,
        },
    });
};

export const listHiringFreezes = async (tenantId, { includeInactive = false } = {}) =>
    prisma.recruitmentHiringFreeze.findMany({
        where: scopedWhere(tenantId, includeInactive ? {} : { isActive: true }),
        orderBy: { id: "desc" },
    });
