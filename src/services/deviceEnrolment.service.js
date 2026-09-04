// src/services/deviceEnrolment.service.js
//
// Which device id belonged to whom, at a given moment.
//
// HR-ATT-DEVICE-ENROLMENT-01. The intake resolves a punch by looking up the
// employee who currently carries that `biometric_id`. That is wrong twice over:
// a re-enrolled employee's new id matches nobody until somebody edits the
// employee row, and a REUSED id silently hands one person's punches to another.
//
// Enrolments are period-scoped, so a punch is matched against the id that was
// current when it happened rather than the id that is current now.
import prisma from "../lib/prisma.js";
import { mcpCtx } from "../mcp/context.js";

/**
 * Resolve device ids to { employeeId, tenantId } as at a point in time.
 *
 * One physical device serves the whole fleet, so its enrolment ids span every
 * tenant and this runs under SYSTEM context. Scoping it to one tenant would
 * silently drop every punch belonging to the others — the HR-ATT-DEVICE-INTAKE-02
 * defect, which resolved ~15% of punches on production.
 *
 * @param {string[]} deviceUserIds
 * @param {Date} at              when the punch happened
 * @param {string} [sn]          device serial; an enrolment with a null `sn`
 *                               matches any device
 * @returns {Promise<Map<string, {employeeId:number, tenantId:string|null, enrolmentId:number}>>}
 */
export async function resolveEnrolmentAt(deviceUserIds, at, sn) {
    const ids = [...new Set(deviceUserIds)].filter(Boolean).map(String);
    const map = new Map();
    if (!ids.length) return map;

    const when = at instanceof Date ? at : new Date(at);

    const rows = await mcpCtx.run({ system: true }, async () => {
        return await prisma.employeeDeviceEnrolment.findMany({
            where: {
                deviceUserId: { in: ids },
                effectiveFrom: { lte: when },
                // Two independent conditions, so they are AND-ed explicitly
                // rather than both written as `OR` (the second would overwrite
                // the first in the same object literal).
                AND: [
                    { OR: [{ effectiveTo: null }, { effectiveTo: { gte: when } }] },
                    ...(sn ? [{ OR: [{ sn: null }, { sn }] }] : []),
                ],
            },
            select: {
                id: true, employeeId: true, tenantId: true,
                deviceUserId: true, effectiveFrom: true, sn: true,
            },
            orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
        });
    });

    // The window is re-checked here rather than left to the query alone. It is
    // the whole rule — "the id that was current WHEN THE PUNCH HAPPENED" — and a
    // rule that lives only in a where-clause cannot be tested, only trusted. The
    // query still narrows the read; this decides.
    const covers = (r) =>
        r.effectiveFrom <= when && (r.effectiveTo == null || r.effectiveTo >= when);

    for (const r of rows) {
        if (!covers(r)) continue;
        if (sn && r.sn && r.sn !== sn) continue;

        // Overlapping enrolments for one id are bad data. Ordered ascending, the
        // last write wins, so the NEWEST period is chosen — deterministic rather
        // than whichever the database happened to return first. A device-specific
        // enrolment also outranks a null-`sn` catch-all.
        const held = map.get(r.deviceUserId);
        if (held && held.sn && !r.sn) continue;
        map.set(r.deviceUserId, {
            employeeId: r.employeeId,
            tenantId: r.tenantId,
            enrolmentId: r.id,
            sn: r.sn,
        });
    }

    return map;
}

/**
 * One read, then resolve each punch at ITS OWN time.
 *
 * A batch is not a moment: the device re-pushes days of backlog after a
 * reconnect, and a re-enrolment inside that window means two punches with the
 * same device id belong to two different people. Resolving the whole batch at
 * one timestamp would hand them both to whoever held the id at that instant.
 *
 * @returns {Promise<(deviceUserId: string, at: Date) => object|undefined>}
 */
export async function buildEnrolmentResolver(deviceUserIds, sn) {
    const ids = [...new Set(deviceUserIds)].filter(Boolean).map(String);
    if (!ids.length) return () => undefined;

    const rows = await mcpCtx.run({ system: true }, async () => {
        return await prisma.employeeDeviceEnrolment.findMany({
            where: { deviceUserId: { in: ids } },
            select: {
                id: true, employeeId: true, tenantId: true,
                deviceUserId: true, effectiveFrom: true, effectiveTo: true, sn: true,
            },
            orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
        });
    });

    const byId = new Map();
    for (const r of rows) {
        if (!byId.has(r.deviceUserId)) byId.set(r.deviceUserId, []);
        byId.get(r.deviceUserId).push(r);
    }

    return (deviceUserId, at) => {
        const when = at instanceof Date ? at : new Date(at);
        const candidates = byId.get(String(deviceUserId)) ?? [];
        let best;
        for (const r of candidates) {
            if (r.effectiveFrom > when) continue;
            if (r.effectiveTo != null && r.effectiveTo < when) continue;
            if (sn && r.sn && r.sn !== sn) continue;
            // Ascending order, so a later row wins; a device-specific enrolment
            // outranks a null-`sn` catch-all.
            if (best && best.sn && !r.sn) continue;
            best = r;
        }
        return best
            ? { employeeId: best.employeeId, tenantId: best.tenantId, enrolmentId: best.id }
            : undefined;
    };
}

/**
 * Close an employee's current enrolment and open a new one.
 *
 * The close date is the day BEFORE the new id takes effect, so the two never
 * overlap: an overlap is exactly the ambiguity this model exists to remove.
 */
export async function reEnrol({ employeeId, tenantId, newDeviceUserId, effectiveFrom, note }) {
    const from = effectiveFrom instanceof Date ? effectiveFrom : new Date(effectiveFrom);
    const closeAt = new Date(from.getTime() - 86_400_000);

    return mcpCtx.run({ system: true }, async () => {
        await prisma.employeeDeviceEnrolment.updateMany({
            where: { employeeId, effectiveTo: null },
            data: { effectiveTo: closeAt },
        });
        return await prisma.employeeDeviceEnrolment.create({
            data: {
                tenantId,
                employeeId,
                deviceUserId: String(newDeviceUserId),
                effectiveFrom: from,
                effectiveTo: null,
                note: note ?? null,
            },
        });
    });
}
