// src/services/payrollApprovalMatrix.service.js — Payroll Setup › Approval Matrix.
//
// CRUD over PayrollApprovalMatrix (table payroll_approval_matrix): the ordered
// list of approval levels a payroll run must clear. Each row is one level:
//   level              (Int — higher number = higher authority)
//   role               (String — the approving role)
//   approverId         (Int? — a specific Employee approver, optional)
//   thresholdRequired  (Bool — level engages only above thresholdAmount)
//   thresholdAmount    (Float? — the amount that triggers this level)
//   autoEscalateAfter  (DateTime? — SLA after which the item auto-escalates)
//   status             (ACTIVE | INACTIVE, RowStatus)
//
// The approver (an Employee) is resolved via the `approver` relation and
// flattened to {id,name,avatar}. Employee columns are snake_case
// (employee_name / first_name / last_name / photo_url).
//
// Tenant scoping is fail-closed via scopedWhere/scopedData (../lib/tenancy.js).
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

const APPROVER_SELECT = {
    select: { id: true, employee_name: true, first_name: true, last_name: true, photo_url: true },
};

function flattenApprover(emp) {
    if (!emp) return null;
    const name =
        emp.employee_name ||
        [emp.first_name, emp.last_name].filter(Boolean).join(" ").trim() ||
        null;
    return { id: emp.id, name, avatar: emp.photo_url || null };
}

function toRow(r) {
    return {
        id: r.id,
        level: r.level,
        role: r.role,
        approver: flattenApprover(r.approver),
        thresholdRequired: r.thresholdRequired,
        thresholdAmount: r.thresholdAmount,
        autoEscalateAfter: r.autoEscalateAfter,
        status: r.status,
    };
}

function coerceEscalate(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
        throw Object.assign(new Error("autoEscalateAfter must be a valid date"), { status: 400 });
    }
    return d;
}

export async function createApprovalLevel({
    tenantId,
    level,
    role,
    approverId,
    thresholdRequired = false,
    thresholdAmount,
    autoEscalateAfter,
    status = "ACTIVE",
}) {
    const lvl = Number(level);
    if (!Number.isInteger(lvl)) {
        throw Object.assign(new Error("level must be an integer"), { status: 400 });
    }
    if (!role || !String(role).trim()) {
        throw Object.assign(new Error("role is required"), { status: 400 });
    }
    const created = await prisma.payrollApprovalMatrix.create({
        data: scopedData(tenantId, {
            level: lvl,
            role: String(role).trim(),
            approverId: approverId === undefined || approverId === null ? null : Number(approverId),
            thresholdRequired: Boolean(thresholdRequired),
            thresholdAmount:
                thresholdAmount === undefined || thresholdAmount === null ? null : Number(thresholdAmount),
            autoEscalateAfter: coerceEscalate(autoEscalateAfter) ?? null,
            status: status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
            version: 1,
        }),
        include: { approver: APPROVER_SELECT },
    });
    logger.info({ id: created.id, tenantId }, "approval level created");
    return toRow(created);
}

export async function updateApprovalLevel({ tenantId, id, ...fields }) {
    const data = {};
    if (fields.level !== undefined) {
        const lvl = Number(fields.level);
        if (!Number.isInteger(lvl)) throw Object.assign(new Error("level must be an integer"), { status: 400 });
        data.level = lvl;
    }
    if (fields.role !== undefined) {
        if (!String(fields.role).trim()) throw Object.assign(new Error("role must not be empty"), { status: 400 });
        data.role = String(fields.role).trim();
    }
    if (fields.approverId !== undefined) {
        data.approverId = fields.approverId === null ? null : Number(fields.approverId);
    }
    if (fields.thresholdRequired !== undefined) data.thresholdRequired = Boolean(fields.thresholdRequired);
    if (fields.thresholdAmount !== undefined) {
        data.thresholdAmount = fields.thresholdAmount === null ? null : Number(fields.thresholdAmount);
    }
    if (fields.autoEscalateAfter !== undefined) data.autoEscalateAfter = coerceEscalate(fields.autoEscalateAfter);
    if (fields.status !== undefined) data.status = fields.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

    // updateMany keeps the tenant scope in the WHERE (fail-closed).
    const res = await prisma.payrollApprovalMatrix.updateMany({
        where: scopedWhere(tenantId, { id: Number(id) }),
        data,
    });
    if (res.count === 0) {
        throw Object.assign(new Error("Approval level not found"), { status: 404 });
    }
    const updated = await prisma.payrollApprovalMatrix.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: { approver: APPROVER_SELECT },
    });
    logger.info({ id: Number(id), tenantId }, "approval level updated");
    return toRow(updated);
}

export async function deleteApprovalLevel({ tenantId, id }) {
    const res = await prisma.payrollApprovalMatrix.deleteMany({
        where: scopedWhere(tenantId, { id: Number(id) }),
    });
    if (res.count === 0) {
        throw Object.assign(new Error("Approval level not found"), { status: 404 });
    }
    logger.info({ id: Number(id), tenantId }, "approval level deleted");
    return { success: true, id: Number(id) };
}

const SORT_FIELDS = {
    level: "level",
    status: "status",
};

export async function listApprovalLevels({ tenantId, status, sortBy, sortDir, page, pageSize } = {}) {
    const where = scopedWhere(tenantId, { ...(status ? { status } : {}) });

    const orderField = SORT_FIELDS[sortBy] || "level";
    const dir = String(sortDir).toLowerCase() === "desc" ? "desc" : "asc";

    const pg = Math.max(1, Number(page) || 1);
    const size = Math.min(200, Math.max(1, Number(pageSize) || 20));

    const [total, rows] = await Promise.all([
        prisma.payrollApprovalMatrix.count({ where }),
        prisma.payrollApprovalMatrix.findMany({
            where,
            orderBy: { [orderField]: dir },
            skip: (pg - 1) * size,
            take: size,
            include: { approver: APPROVER_SELECT },
        }),
    ]);

    return { items: rows.map(toRow), total, page: pg, pageSize: size };
}
