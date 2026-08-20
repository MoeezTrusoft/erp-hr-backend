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
import { mcpCtx } from "../mcp/context.js";
import { syncAttendanceFromPunches } from "./attendance.device.service.js";
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
 * Resolve deviceUserId -> Employee.id for a batch. biometric_id is the dedicated
 * device key; employee_code is the pre-biometric fallback.
 */
async function buildEmployeeMap(deviceUserIds) {
    const ids = [...new Set(deviceUserIds)].filter(Boolean);
    if (!ids.length) return new Map();
    const employees = await prisma.employee.findMany({
        where: { OR: [{ biometric_id: { in: ids } }, { employee_code: { in: ids } }] },
        select: { id: true, biometric_id: true, employee_code: true },
    });
    const map = new Map();
    // biometric_id wins over employee_code on collision.
    for (const e of employees) if (e.employee_code) map.set(e.employee_code, e.id);
    for (const e of employees) if (e.biometric_id) map.set(e.biometric_id, e.id);
    return map;
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

    // Single tenant context for the whole batch: raw store + roll-up.
    return mcpCtx.run({ user: { tenantId } }, async () => {
        const empMap = await buildEmployeeMap(parsed.map((p) => p.deviceUserId));

        const createData = parsed.map((p) => {
            const employeeId = empMap.get(p.deviceUserId) ?? null;
            if (employeeId) summary.resolved += 1;
            else summary.unresolved += 1;
            return {
                sn,
                deviceUserId: p.deviceUserId,
                punchedAt: p.punchedAt,
                status: p.status,
                verifyMode: p.verifyMode,
                workCode: p.workCode,
                employeeId,
                rawLine: p.rawLine,
                tenantId,
            };
        });

        // Idempotent: the device re-pushes on reconnect; the natural-key unique
        // index dedupes. skipDuplicates keeps a re-import a no-op.
        const res = await prisma.attendanceDevicePunch.createMany({
            data: createData,
            skipDuplicates: true,
        });
        summary.rawStored = res.count;

        if (rollup) {
            // Feed the existing daily roll-up. status 0 -> IN, 1 -> OUT; parseType
            // in the device service already understands "0"/"1".
            const punches = parsed.map((p) => ({
                deviceUserId: p.deviceUserId,
                timestamp: p.punchedAt.toISOString(),
                type: String(p.status),
            }));
            try {
                summary.rollup = await syncAttendanceFromPunches({ punches });
            } catch (err) {
                // Raw rows are already durable; a roll-up failure must not lose them.
                logger.error({ err: err?.message, sn }, "device intake: roll-up failed (raw stored)");
                summary.rollup = { error: err?.message || "rollup failed" };
            }
        }

        logger.info(
            { sn, received: summary.received, rawStored: summary.rawStored, resolved: summary.resolved },
            "device intake: batch ingested"
        );
        return summary;
    });
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
    };

    // When called outside an established MCP context (tests / internal), set one.
    return tenantId ? mcpCtx.run({ user: { tenantId } }, run) : run();
}
