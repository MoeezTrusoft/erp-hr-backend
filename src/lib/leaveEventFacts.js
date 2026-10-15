// src/lib/leaveEventFacts.js: shared, pure leave-event payload facts.
//
// Used by the approval finalizer (hr.leave.approved.v1 / hr.leave.rejected.v1)
// and the hrEvents.js builders so both emit the same backwards-compatible
// additions: leaveRequestId, leavePolicyId, totalDays, startDate, endDate.

// Inclusive leave dates as YYYY-MM-DD (the UTC calendar day Prisma stores,
// matching the ::date the availability trigger uses), or null.
export function toDateOnly(value) {
    if (value == null) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Shared non-PII facts of a leave decision (hr.leave.approved.v1 /
// hr.leave.rejected.v1). Backwards-compatible additions for PM and Visual
// readers: startDate/endDate give the affected range without a lookup.
export function leaveEventFacts(req) {
    const totalDays = req?.totalDays == null ? NaN : Number(req.totalDays);
    return {
        leaveRequestId: req?.id != null ? String(req.id) : null,
        leavePolicyId: req?.leavePolicyId != null ? String(req.leavePolicyId) : null,
        totalDays: Number.isFinite(totalDays) ? totalDays : null,
        startDate: toDateOnly(req?.startDate),
        endDate: toDateOnly(req?.endDate),
    };
}
