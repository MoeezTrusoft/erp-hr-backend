// HR-ATT-DEVICE-INTAKE-01 — ADMS/iclock push intake.
//
// The MB460 Plus firmware refuses the legacy pyzk TCP SDK, so we no longer pull
// from the device — it PUSHES its ATTLOG rows to us over HTTP. This service is
// the single write path for those rows: it persists every punch raw (durable,
// idempotent) and then rolls them up into the daily Attendance table by reusing
// the existing syncAttendanceFromPunches() so late/half-day calc stays identical
// to the manual sync tool.
//
// Everything runs inside mcpCtx.run({ user: { tenantId } }) so the FORCE-RLS
// tenant policy on Employee / Attendance / attendance_device_punches is honored:
// the device carries no tenant, so the caller supplies it (one physical device
// serves one company).

import prisma from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { mcpCtx } from "../mcp/context.js";
import { syncAttendanceFromPunches } from "./attendance.device.service.js";
import { applyEvaluatedShiftsForDays } from "./attendanceWriter.service.js";
import logger from "../lib/logger.js";

/**
 * Parse one tab-separated iclock ATTLOG row.
 *   userid \t YYYY-MM-DD HH:MM:SS \t status \t verify \t workcode ...
 * Returns null for a row we cannot use (missing id or unparseable time).
 */
export function parseAttlogRow(line) {
    if (typeof line !== "string") return null;
    const c = line.split("\t");
    const deviceUserId = (c[0] || "").trim();
    const timeStr = (c[1] || "").trim();
    if (!deviceUserId || !timeStr) return null;
    const punchedAt = new Date(timeStr.replace(" ", "T"));
    if (Number.isNaN(punchedAt.getTime())) return null;
    const num = (v, d = 0) => {
        const n = Number((v ?? "").toString().trim());
        return Number.isFinite(n) ? n : d;
    };
    return {
        deviceUserId,
        punchedAt,
        status: num(c[2]),
        verifyMode: num(c[3]),
        workCode: num(c[4]),
        rawLine: line,
    };
}

/**
 * Resolve deviceUserId -> { employeeId, tenantId } for a batch.
 *
 * The enrolment id is matched against Employee.biometric_id, then
 * Employee.employee_code. There is deliberately no Person lookup: no Person
 * model exists in schema.prisma, so `prisma.person` is undefined and calling it
 * throws a TypeError on every batch.
 *
 * One physical device serves the whole fleet: its enrolment ids span every
 * tenant, so this runs under SYSTEM context (RLS bypass). Scoping the lookup to
 * a single tenant silently drops every punch belonging to the other tenants —
 * they store as unresolved and never reach the daily Attendance table.
 * The caller stamps each punch with the tenant that comes back here.
 */
async function buildEmployeeMap(deviceUserIds) {
    const ids = [...new Set(deviceUserIds)].filter(Boolean);
    if (!ids.length) return new Map();

    return mcpCtx.run({ system: true }, async () => {
        const map = new Map();
        const employees = await prisma.employee.findMany({
            where: { OR: [{ biometric_id: { in: ids } }, { employee_code: { in: ids } }] },
            select: { id: true, biometric_id: true, employee_code: true, tenant_id: true },
        });
        for (const e of employees) {
            const entry = { employeeId: e.id, tenantId: e.tenant_id };
            if (e.employee_code) map.set(e.employee_code, entry);
            if (e.biometric_id) map.set(e.biometric_id, entry);
        }
        return map;
    });
}

/**
 * Ingest a batch of ATTLOG rows for one device.
 *
 * @param {object} args
 * @param {string} args.sn        device serial (iclock SN)
 * @param {string[]} args.rows    raw tab-separated ATTLOG lines
 * @param {string} args.tenantId  company UUID the device's employees belong to
 * @param {boolean} [args.rollup] also update the daily Attendance table (default true)
 */
export async function ingestDevicePunches({ sn, rows, tenantId, rollup = true }) {
    if (!tenantId) throw Object.assign(new Error("tenantId is required for device intake"), { status: 400 });
    if (!sn) throw Object.assign(new Error("sn is required"), { status: 400 });
    const lines = Array.isArray(rows) ? rows : [];

    const parsed = [];
    let unparsable = 0;
    for (const line of lines) {
        const p = parseAttlogRow(line);
        if (p) parsed.push(p);
        else unparsable += 1;
    }

    const summary = {
        sn,
        received: lines.length,
        parsed: parsed.length,
        unparsable,
        rawStored: 0,
        resolved: 0,
        unresolved: 0,
        rollup: null,
    };

    if (!parsed.length) return summary;

    // Fleet-wide resolution: one device, many tenants. Each punch carries the
    // tenant of the employee it resolved to; `tenantId` is only the fallback for
    // enrolment ids that match nobody, so unresolved rows stay attributable.
    const empMap = await buildEmployeeMap(parsed.map((p) => p.deviceUserId));

    const createData = parsed.map((p) => {
        const hit = empMap.get(p.deviceUserId) ?? null;
        if (hit) summary.resolved += 1;
        else summary.unresolved += 1;
        return {
            sn,
            deviceUserId: p.deviceUserId,
            punchedAt: p.punchedAt,
            status: p.status,
            verifyMode: p.verifyMode,
            workCode: p.workCode,
            employeeId: hit?.employeeId ?? null,
            rawLine: p.rawLine,
            tenantId: hit?.tenantId ?? tenantId,
        };
    });

    // Rows span tenants, so the write runs under SYSTEM context. Idempotent: the
    // device re-pushes on reconnect and the natural-key unique index dedupes.
    // NOTE tenantId is part of that key — re-pushing the same punch under a
    // different tenant duplicates it rather than deduping.
    // The await MUST be inside the context callback. A Prisma call returns a lazy
    // PrismaPromise: returning it unawaited hands the un-executed query back to
    // mcpCtx.run, the async-local store unwinds, and the query then executes with
    // no context — tenantScope denies it with HR-4030.
    const res = await mcpCtx.run({ system: true }, async () => {
        return await prisma.attendanceDevicePunch.createMany({
            data: createData,
            skipDuplicates: true,
        });
    });
    summary.rawStored = res.count;

    if (rollup) {
        // Feed the existing daily roll-up. status 0 -> IN, 1 -> OUT; parseType
        // in the device service already understands "0"/"1".
        // syncAttendanceFromPunches re-resolves employees under the ambient
        // tenant, so it must be called once per tenant present in the batch.
        const byTenant = new Map();
        for (const row of createData) {
            if (!row.employeeId) continue;
            if (!byTenant.has(row.tenantId)) byTenant.set(row.tenantId, []);
            byTenant.get(row.tenantId).push({
                deviceUserId: row.deviceUserId,
                timestamp: row.punchedAt.toISOString(),
                type: String(row.status),
            });
        }

        summary.rollup = {};
        for (const [tid, punches] of byTenant) {
            try {
                summary.rollup[tid] = await mcpCtx.run({ user: { tenantId: tid } }, async () => {
                    // HR-ATT-CUTOVER-01: the EVALUATOR is the write path now.
                    // Previously the roll-up used calendar-day logic while the
                    // evaluator only produced reports, so what the reports
                    // showed and what the product stored were two different
                    // things. Both go through one code path now.
                    //
                    // ATTENDANCE_USE_EVALUATOR=false falls back to the old
                    // roll-up — a switch back that needs no redeploy.
                    if (process.env.ATTENDANCE_USE_EVALUATOR === "false") {
                        return await syncAttendanceFromPunches({ punches });
                    }
                    return await applyEvaluatedShiftsForDays({
                        tenantId: tid,
                        days: punches.map((p) => new Date(p.timestamp)),
                    });
                });
            } catch (err) {
                // Raw rows are already durable; a roll-up failure must not lose
                // them, and one tenant failing must not skip the others.
                logger.error(
                    { err: err?.message, sn, tenantId: tid },
                    "device intake: roll-up failed (raw stored)",
                );
                summary.rollup[tid] = { error: err?.message || "rollup failed" };
            }
        }
    }

    logger.info(
        { sn, received: summary.received, rawStored: summary.rawStored, resolved: summary.resolved },
        "device intake: batch ingested"
    );
    return summary;
}

/**
 * Re-link punches that stored unresolved and can be resolved now.
 * HR-ATT-ORPHAN-RESOLVE-01.
 *
 * Resolution happens once, at write time. A punch whose enrolment id matched
 * nobody stores with `employeeId: null` and — see the createData map above —
 * the DEVICE's fallback tenant. When HR enrols the person a day later nothing
 * revisits those rows, so they stay orphaned and never reach Attendance.
 *
 * Both columns have to be corrected. The fallback tenant is Trusoft's for every
 * orphan, but the employees span the fleet: writing `employeeId` alone leaves an
 * EMG employee's punch stamped Trusoft, invisible to his own tenant under RLS,
 * and the roll-up that follows reads zero rows while reporting success.
 *
 * Re-linking a punch does not create attendance by itself, so the affected days
 * are re-evaluated per tenant afterwards.
 *
 * @param {object} [args]
 * @param {boolean} [args.dryRun=true]  report only; write nothing
 * @param {string}  [args.deviceUserId] restrict to one enrolment id
 */
export async function resolveOrphanPunches({ dryRun = true, deviceUserId } = {}) {
    const orphans = await mcpCtx.run({ system: true }, async () => {
        return await prisma.attendanceDevicePunch.findMany({
            where: { employeeId: null, ...(deviceUserId ? { deviceUserId } : {}) },
            select: { id: true, deviceUserId: true, punchedAt: true, tenantId: true },
            orderBy: { punchedAt: "asc" },
        });
    });

    const summary = {
        scanned: orphans.length,
        resolved: 0,
        movedTenant: 0,
        stillUnresolved: [],
        rollup: {},
        dryRun,
    };
    if (!orphans.length) return summary;

    const empMap = await buildEmployeeMap(orphans.map((p) => p.deviceUserId));

    // Affected days per tenant, so the evaluator re-runs exactly where a punch
    // moved. A Set keyed by ISO day keeps a busy employee from re-evaluating the
    // same day once per punch.
    const daysByTenant = new Map();
    const unresolved = new Set();

    for (const p of orphans) {
        const hit = empMap.get(p.deviceUserId);
        if (!hit) {
            unresolved.add(p.deviceUserId);
            continue;
        }
        summary.resolved += 1;
        if (hit.tenantId !== p.tenantId) summary.movedTenant += 1;

        if (!daysByTenant.has(hit.tenantId)) daysByTenant.set(hit.tenantId, new Set());
        daysByTenant.get(hit.tenantId).add(p.punchedAt.toISOString().slice(0, 10));

        if (dryRun) continue;
        await mcpCtx.run({ system: true }, async () => {
            return await prisma.attendanceDevicePunch.update({
                where: { id: p.id },
                data: { employeeId: hit.employeeId, tenantId: hit.tenantId },
            });
        });
    }

    summary.stillUnresolved = [...unresolved];
    if (dryRun) return summary;

    for (const [tid, days] of daysByTenant) {
        try {
            summary.rollup[tid] = await mcpCtx.run({ user: { tenantId: tid } }, async () => {
                return await applyEvaluatedShiftsForDays({
                    tenantId: tid,
                    days: [...days].map((d) => new Date(`${d}T00:00:00.000Z`)),
                });
            });
        } catch (err) {
            // One tenant failing must not skip the others; the punches are
            // already re-linked and durable either way.
            logger.error(
                { err: err?.message, tenantId: tid },
                "orphan re-resolve: roll-up failed (punches re-linked)",
            );
            summary.rollup[tid] = { error: err?.message || "rollup failed" };
        }
    }

    logger.info(summary, "orphan re-resolve: complete");
    return summary;
}

/**
 * Fetch raw device punches, filterable by employee or device id and a date
 * window. Runs under the caller's tenant so RLS scopes it. Paginated.
 */
export async function listDevicePunches({
    tenantId,
    employeeId,
    deviceUserId,
    sn,
    from,
    to,
    page = 1,
    pageSize = 100,
} = {}) {
    const take = Math.min(Math.max(Number(pageSize) || 100, 1), 500);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where = {};
    if (employeeId != null && employeeId !== "") where.employeeId = Number(employeeId);
    if (deviceUserId) where.deviceUserId = String(deviceUserId);
    if (sn) where.sn = String(sn);
    if (from || to) {
        where.punchedAt = {};
        if (from) where.punchedAt.gte = new Date(from);
        if (to) where.punchedAt.lte = new Date(to);
    }

    const run = async () => {
        try {
            const [rows, total] = await Promise.all([
                prisma.attendanceDevicePunch.findMany({
                    where,
                    orderBy: { punchedAt: "desc" },
                    take,
                    skip,
                }),
                prisma.attendanceDevicePunch.count({ where }),
            ]);
            return { rows, total, page: Math.max(Number(page) || 1, 1), pageSize: take };
        } catch (err) {
            // ERR-3 / fail-closed: a structural DB error (missing table P2021 or
            // missing column P2022) must not escape as an unhandled 5xx that also
            // leaks the internal schema name to the caller. Log the real cause
            // server-side; return a clean 4xx so the tool degrades without a 5xx.
            if (err instanceof Prisma.PrismaClientKnownRequestError &&
                (err.code === "P2021" || err.code === "P2022")) {
                logger.error(
                    { code: err.code, model: err.meta?.modelName, table: err.meta?.table },
                    "listDevicePunches: attendance device punch store not provisioned",
                );
                throw Object.assign(
                    new Error("Attendance device punch store is not available"),
                    { status: 404 },
                );
            }
            throw err;
        }
    };

    // When called outside an established MCP context (tests / internal), set one.
    return tenantId ? mcpCtx.run({ user: { tenantId } }, run) : run();
}
