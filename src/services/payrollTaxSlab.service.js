// src/services/payrollTaxSlab.service.js — Payroll Setup › Tax slabs.
//
// CRUD over the TaxRate model (table tax_rates). Each row is one FBR-style
// income-tax slab:
//   from       = bracketMin   (Decimal(18,4), ≥0)
//   upto       = bracketMax   (Decimal(18,4)?, null ⇒ open-ended top slab)
//   base tax   = baseTax      (Decimal(18,4), cumulative tax owed to bracketMin)
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
import { compareDecimal, decimalToPersistence } from "../lib/money.js";

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
        from: decimalToPersistence(r.bracketMin),
        upto: r.bracketMax == null ? null : decimalToPersistence(r.bracketMax),
        baseTax: decimalToPersistence(r.baseTax),
        rateOnExcess: r.rate,
        ratePct: round2(r.rate * 100),
        effectiveFrom: r.effectiveFrom,
        status: r.status,
        countryCode: r.countryCode,
    };
}

// [CHECK23] ACTIVE-slab overlap guard (T-2.5 / plan 25 B1).
//
// Within a tenant+country, a NEW/EDITED ACTIVE slab must not overlap any
// already-ACTIVE slab's bracket range. Shared endpoints coexist (600000-1200000
// beside 1200000-1800000 is the normal FBR ladder); open-ended tops count to
// +inf. INACTIVE rows are ignored — retirement via deactivate is the sanctioned
// dedup path. Used by BOTH createTaxSlab and updateTaxSlab.
async function assertNoActiveOverlap(tenantId, countryCode, min, max, excludeId = null) {
    const actives = await prisma.taxRate.findMany({
        where: scopedWhere(tenantId, {
            countryCode: String(countryCode).toUpperCase().slice(0, 2),
            status: "ACTIVE",
        }),
    });
    const overlap = actives.some((r) => {
        if (excludeId != null && r.id === excludeId) return false;
        const rMin = r.bracketMin;
        const rMax = r.bracketMax; // null = open-ended top
        if (compareDecimal(rMax ?? Infinity, min) <= 0) return false; // below, or touching at our start
        if (max != null && compareDecimal(max, rMin) <= 0) return false; // above, or touching at our end
        return true;
    });
    if (overlap) {
        throw Object.assign(
            new Error("bracket overlaps an existing ACTIVE slab for this country — deactivate the duplicate or merge the ranges"),
            { status: 409 },
        );
    }
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
    const min = decimalToPersistence(bracketMin);
    if (compareDecimal(min, '0') < 0) {
        throw Object.assign(new Error("bracketMin must be a number ≥ 0"), { status: 400 });
    }
    let max = null;
    if (bracketMax !== undefined && bracketMax !== null) {
        max = decimalToPersistence(bracketMax);
        if (compareDecimal(max, min) <= 0) {
            throw Object.assign(new Error("bracketMax must be greater than bracketMin (or null for the top slab)"), { status: 400 });
        }
    }
    const normRate = normalizeRate(rate);
    const base = decimalToPersistence(baseTax === undefined || baseTax === null ? '0' : baseTax);
    if (compareDecimal(base, '0') < 0) {
        throw Object.assign(new Error("baseTax must be a number ≥ 0"), { status: 400 });
    }
    const from = effectiveFrom ? new Date(effectiveFrom) : new Date();
    if (Number.isNaN(from.getTime())) {
        throw Object.assign(new Error("effectiveFrom must be a valid date"), { status: 400 });
    }

    // [CHECK23] guard ACTIVE writes; INACTIVE creation is the sanctioned
    // way to pre-stage a slab, so only ACTIVE writes check overlap.
    if (status !== "INACTIVE") {
        await assertNoActiveOverlap(tenantId, countryCode, min, max);
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
        const min = decimalToPersistence(fields.bracketMin);
        if (compareDecimal(min, '0') < 0) throw Object.assign(new Error("bracketMin must be a number ≥ 0"), { status: 400 });
        data.bracketMin = min;
    }
    if (fields.bracketMax !== undefined) {
        if (fields.bracketMax === null) {
            data.bracketMax = null;
        } else {
            const max = decimalToPersistence(fields.bracketMax);
            if (data.bracketMin != null && compareDecimal(max, data.bracketMin) <= 0) {
                throw Object.assign(new Error("bracketMax must be greater than bracketMin (or null)"), { status: 400 });
            }
            data.bracketMax = max;
        }
    }
    if (fields.baseTax !== undefined) {
        const base = decimalToPersistence(fields.baseTax);
        if (compareDecimal(base, '0') < 0) throw Object.assign(new Error("baseTax must be a number ≥ 0"), { status: 400 });
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

    // [CHECK23] overlap guard for ACTIVE writes. Skip when the write itself
    // deactivates (retirement is always allowed). The edit is evaluated against
    // its own post-write bracket, excluding itself.
    const willBeActive = (fields.status !== undefined ? fields.status !== "INACTIVE" : true);
    if (willBeActive && (data.bracketMin !== undefined || data.bracketMax !== undefined || fields.status !== undefined)) {
        const current = await prisma.taxRate.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
        if (!current) throw Object.assign(new Error("Tax slab not found"), { status: 404 });
        const min = data.bracketMin !== undefined ? data.bracketMin : current.bracketMin;
        const max = data.bracketMax !== undefined ? data.bracketMax : current.bracketMax;
        await assertNoActiveOverlap(tenantId, data.countryCode ?? current.countryCode, min, max, Number(id));
    }

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
