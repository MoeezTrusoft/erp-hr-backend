// O-05 (audit 2026-11-08) — on-demand T&A and payroll health check. Problems used
// to surface only when someone read a payslip. Pure evaluation, no I/O: the
// service gathers rows and passes them in, so every threshold is testable.

export const THRESHOLDS = Object.freeze({
  anomalyDays: 5, // a raised request still undecided after this many days
  runDays: 7, // a run not finalized this many days after its period ended
});
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const check = (code, title, items, detail) => ({ code, title, status: items.length ? "ATTENTION" : "OK", count: items.length, detail, items: items.slice(0, 10) });

/** devices: [{sn,name,active,lastSeenAt,staleAfterMinutes}], anomalies: [{id,createdAt,date}], runs: [{id,periodStart,periodEnd,status}] */
// X1: published approval routes. A level that can act but has no active approver stalls every request that
// reaches it (the engine refuses to seal such a route), so it is surfaced before someone submits.
// routes: [{kind, version, levels:[{name, approverMode, approverIds, paused, required}]}]; people: Map id -> {active}
export function brokenRouteLevels(routes = [], people = new Map()) {
  const out = [];
  for (const r of routes)
    for (const [i, l] of (r.levels || []).entries()) {
      if (l.paused || l.approverMode !== "NAMED") continue; // manager-routed levels resolve per employee
      const ids = l.approverIds || [];
      const active = ids.filter((id) => people.get(id)?.active);
      if (!active.length) out.push({ kind: r.kind, version: r.version, level: i + 1, name: l.name, reason: ids.length ? "every named approver is inactive or missing" : "no approver assigned" });
    }
  return out;
}

export function evaluateHealth({ now = new Date(), devices = [], anomalies = [], runs = [], heldPayslips = 0, routes = [], people = new Map(), thresholds = THRESHOLDS }) {
  const t = +new Date(now);
  const staleDevices = devices
    .filter((d) => d.active)
    .filter((d) => !d.lastSeenAt || t - +new Date(d.lastSeenAt) > (d.staleAfterMinutes ?? 30) * 60000)
    .map((d) => ({ sn: d.sn, name: d.name, lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null }));
  const agedCases = anomalies
    .filter((a) => t - +new Date(a.createdAt) > thresholds.anomalyDays * DAY)
    .map((a) => ({ id: a.id, date: a.date ? iso(a.date) : null, ageDays: Math.floor((t - +new Date(a.createdAt)) / DAY) }))
    .sort((a, b) => b.ageDays - a.ageDays || a.id - b.id);
  const openRuns = runs
    .filter((r) => !["FINALIZED", "CANCELLED"].includes(r.status))
    .filter((r) => t - +new Date(r.periodEnd) > thresholds.runDays * DAY)
    .map((r) => ({ id: r.id, period: `${iso(r.periodStart)} to ${iso(r.periodEnd)}`, status: r.status, daysSincePeriodEnd: Math.floor((t - +new Date(r.periodEnd)) / DAY) }))
    .sort((a, b) => b.daysSincePeriodEnd - a.daysSincePeriodEnd || a.id - b.id);
  const checks = [
    check("DEVICE_STALE", "Active capture devices not heard from within their window", staleDevices, "Punches from these devices may be missing"),
    check("CASES_AGED", `Raised attendance requests undecided for more than ${thresholds.anomalyDays} days`, agedCases, "They block payroll processing"),
    check("RUNS_NOT_CLOSED", `Payroll runs not finalized ${thresholds.runDays} days after the period ended`, openRuns, "Closed months should not stay open"),
    check("APPROVAL_ROUTE_BROKEN", "Published approval routes with a level nobody active can act on", brokenRouteLevels(routes, people), "Requests reaching that level cannot be decided; republish the route with active approvers"),
    { code: "PAYSLIPS_HELD", title: "Held payslips", status: heldPayslips > 0 ? "ATTENTION" : "OK", count: heldPayslips, detail: "Held payslips block approval", items: [] },
  ];
  return { asOf: new Date(t).toISOString(), overall: checks.some((c) => c.status === "ATTENTION") ? "ATTENTION" : "OK", checks };
}
