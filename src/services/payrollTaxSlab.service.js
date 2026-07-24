// src/services/payrollTaxSlab.service.js — Payroll Setup › Tax slabs.
//
// CRUD over the TaxRate model (table tax_rates). Each row is one FBR-style
// income-tax slab:
//   from       = bracketMin   (Float, ≥0)
//   upto       = bracketMax   (Float?, null ⇒ open-ended top slab)
//   base tax   = baseTax      (Float, cumulative tax owed up to bracketMin)
//   rate on excess = rate     (Float fraction 0–1, e.g. 0.15 ⇒ 15% on the
//                              income ABOVE bracketMin)
//   effective from = effectiveFrom (DateTime)
//   status     = ACTIVE | INACTIVE (RowStatus)
//
// Tenant scoping is fail-closed via scopedWhere/scopedData (../lib/tenancy.js);
// the tenant is auto-stamped on create. No console — pino logger only.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// Rate is stored as a fraction (0–1). Callers are expected to pass a fraction,
// but the FBR UI often thinks in percent — if a value >1 is passed we treat it
// as a percent and divide by 100 (e.g. 15 ⇒ 0.15). Values in [0,1] pass through.
function normalizeRate(rate) {
    if (rate === undefined || rate === null) return rate;
    const n = Number(rate);
    if (Number.isNaN(n) || n < 0) {
        throw Object.assign(new Error("rate must be a non-negative number"), { status: 400 });
    }
    // >1 ⇒ interpret as percent; divide by 100. Then clamp-validate to 0–1.
    const frac = n > 1 ? n / 100 : n;
    if (frac < 0 || frac > 1) {
        throw Object.assign(new Error("rate must resolve to a fraction between 0 and 1"), { status: 400 });
    }
    return frac;
}

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toRow(r) {
    return {
        id: r.id,
        from: r.bracketMin,
        upto: r.bracketMax,
        baseTax: r.baseTax,
        rateOnExcess: r.rate,
        ratePct: round2(r.rate * 100),
        effectiveFrom: r.effectiveFrom,
        status: r.status,
        countryCode: r.countryCode,
    };
}

export async function createTaxSlab({
    tenantId,
    countryCode = "PK",
    bracketMin,
    bracketMax,
    baseTax = 0,
    rate,
    effectiveFrom,
    status = "ACTIVE",
}) {
    const min = Number(bracketMin);
    if (Number.isNaN(min) || min < 0) {
        throw Object.assign(new Error("bracketMin must be a number ≥ 0"), { status: 400 });
    }
    let max = null;
    if (bracketMax !== undefined && bracketMax !== null) {
        max = Number(bracketMax);
        if (Number.isNaN(max) || max <= min) {
            throw Object.assign(new Error("bracketMax must be greater than bracketMin (or null for the top slab)"), { status: 400 });
        }
    }
    const normRate = normalizeRate(rate);
    const base = baseTax === undefined || baseTax === null ? 0 : Number(baseTax);
    if (Number.isNaN(base) || base < 0) {
        throw Object.assign(new Error("baseTax must be a number ≥ 0"), { status: 400 });
    }
    const from = effectiveFrom ? new Date(effectiveFrom) : new Date();
    if (Number.isNaN(from.getTime())) {
        throw Object.assign(new Error("effectiveFrom must be a valid date"), { status: 400 });
    }

    const created = await prisma.taxRate.create({
        data: scopedData(tenantId, {
            countryCode: String(countryCode).toUpperCase().slice(0, 2),
            bracketMin: min,
            bracketMax: max,
            baseTax: base,
            rate: normRate,
            effectiveFrom: from,
            status: status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
        }),
    });
    logger.info({ id: created.id, tenantId }, "tax slab created");
    return toRow(created);
}

export async function updateTaxSlab({ tenantId, id, ...fields }) {
    const data = {};
    if (fields.countryCode !== undefined) data.countryCode = String(fields.countryCode).toUpperCase().slice(0, 2);
    if (fields.bracketMin !== undefined) {
        const min = Number(fields.bracketMin);
        if (Number.isNaN(min) || min < 0) throw Object.assign(new Error("bracketMin must be a number ≥ 0"), { status: 400 });
        data.bracketMin = min;
    }
    if (fields.bracketMax !== undefined) {
        if (fields.bracketMax === null) {
            data.bracketMax = null;
        } else {
            const max = Number(fields.bracketMax);
            const min = data.bracketMin ?? Number.NEGATIVE_INFINITY;
            if (Number.isNaN(max) || (Number.isFinite(min) && max <= min)) {
                throw Object.assign(new Error("bracketMax must be greater than bracketMin (or null)"), { status: 400 });
            }
            data.bracketMax = max;
        }
    }
    if (fields.baseTax !== undefined) {
        const base = Number(fields.baseTax);
        if (Number.isNaN(base) || base < 0) throw Object.assign(new Error("baseTax must be a number ≥ 0"), { status: 400 });
        data.baseTax = base;
    }
    if (fields.rate !== undefined) data.rate = normalizeRate(fields.rate);
    if (fields.effectiveFrom !== undefined) {
        const d = new Date(fields.effectiveFrom);
        if (Number.isNaN(d.getTime())) throw Object.assign(new Error("effectiveFrom must be a valid date"), { status: 400 });
        data.effectiveFrom = d;
    }
    if (fields.effectiveTo !== undefined) {
        if (fields.effectiveTo === null) data.effectiveTo = null;
        else {
            const d = new Date(fields.effectiveTo);
            if (Number.isNaN(d.getTime())) throw Object.assign(new Error("effectiveTo must be a valid date"), { status: 400 });
            data.effectiveTo = d;
        }
    }
    if (fields.status !== undefined) data.status = fields.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

    // updateMany so the tenant scope is enforced in the WHERE (fail-closed) —
    // a cross-tenant id resolves to 0 rows rather than mutating another tenant.
    const res = await prisma.taxRate.updateMany({
        where: scopedWhere(tenantId, { id: Number(id) }),
        data,
    });
    if (res.count === 0) {
        throw Object.assign(new Error("Tax slab not found"), { status: 404 });
    }
    const updated = await prisma.taxRate.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    logger.info({ id: Number(id), tenantId }, "tax slab updated");
    return toRow(updated);
}

export async function deleteTaxSlab({ tenantId, id }) {
    const res = await prisma.taxRate.deleteMany({
        where: scopedWhere(tenantId, { id: Number(id) }),
    });
    if (res.count === 0) {
        throw Object.assign(new Error("Tax slab not found"), { status: 404 });
    }
    logger.info({ id: Number(id), tenantId }, "tax slab deleted");
    return { success: true, id: Number(id) };
}

const SORT_FIELDS = {
    from: "bracketMin",
    effectiveFrom: "effectiveFrom",
    status: "status",
};

export async function listTaxSlabs({ tenantId, status, countryCode, sortBy, sortDir, page, pageSize } = {}) {
    const where = scopedWhere(tenantId, {
        ...(status ? { status } : {}),
        ...(countryCode ? { countryCode: String(countryCode).toUpperCase().slice(0, 2) } : {}),
    });

    const orderField = SORT_FIELDS[sortBy] || "bracketMin";
    const dir = String(sortDir).toLowerCase() === "desc" ? "desc" : "asc";

    const pg = Math.max(1, Number(page) || 1);
    const size = Math.min(200, Math.max(1, Number(pageSize) || 20));

    const [total, rows] = await Promise.all([
        prisma.taxRate.count({ where }),
        prisma.taxRate.findMany({
            where,
            orderBy: { [orderField]: dir },
            skip: (pg - 1) * size,
            take: size,
        }),
    ]);

    return { items: rows.map(toRow), total, page: pg, pageSize: size };
}
