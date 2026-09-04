// scripts/apply-employment-periods.mjs — HR-PAYROLL-EMPLOYMENT-PERIOD-01
//
// Records the staffing changes the operator supplied, now that employment can
// be expressed as periods rather than a single hire_date:
//
//   M. Meesam  terminated 2026-08-20, RE-HIRED from 2026-09-07
//   affan      left last month
//   afzal      left last month
//   shizza     left last month
//
// M. Meesam is why the model exists. He is paid to 2026-08-19 (the day of
// leaving is not worked, so August is 19/31) and from 2026-09-07 (September is
// 24/30). His original hire_date is left alone — it is the tenure anchor for
// leave accrual, gratuity and probation, and overwriting it to make September
// prorate would destroy that.
//
// The three earlier leavers had no exact date from HR beyond "left last month",
// so they are closed at the end of July. That is stated rather than guessed at a
// finer resolution: a wrong day inside July changes nobody's pay, because their
// last payroll was July and it has already run, whereas leaving them open would
// keep paying them indefinitely.
//
// Deactivation is deliberately NOT done by setting status alone — that drops an
// employee from the payroll query entirely and loses the days they did work.
// Closing the period is what stops the pay; the status flag follows it.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const PLAN = [
  {
    match: "Meesam",
    // Closes the open spell, then opens a new one. Two rows, one person.
    closeOn: "2026-08-19",
    closeReason: "Terminated 2026-08-20; paid to 2026-08-19",
    reopenOn: "2026-09-07",
    reopenReason: "Re-hired, joined 2026-09-07",
    deactivate: false, // he is employed again
  },
  { match: "affan", closeOn: "2026-07-31", closeReason: "Left (before August 2026)", deactivate: true },
  { match: "afzal", closeOn: "2026-07-31", closeReason: "Left (before August 2026)", deactivate: true },
  { match: "shizza", closeOn: "2026-07-31", closeReason: "Left (before August 2026)", deactivate: true },
];

const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

let failures = 0;

for (const item of PLAN) {
  let found = null;

  for (const [name, tenantId] of Object.entries(TENANTS)) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      if (found) return;
      const all = await prisma.employee.findMany({
        select: {
          id: true, employee_code: true, employee_name: true,
          first_name: true, last_name: true, hire_date: true,
          joining_date: true, status: true,
        },
      });
      const want = norm(item.match);
      const hits = all.filter((e) => {
        const nm = norm(e.employee_name || `${e.first_name ?? ""} ${e.last_name ?? ""}`);
        return nm === want || nm.split(" ").includes(want) || nm.includes(want);
      });
      if (hits.length === 1) found = { tenant: name, tenantId, emp: hits[0] };
      else if (hits.length > 1) {
        console.log(
          `  ! ${item.match}: ${hits.length} matches in ${name} -> ` +
            hits.map((h) => `${h.employee_code} ${h.employee_name}`).join(" | "),
        );
        found = "ambiguous";
      }
    });
    if (found) break;
  }

  if (!found || found === "ambiguous") {
    if (!found) console.log(`  ! ${item.match}: not found in any tenant`);
    failures += 1;
    continue;
  }

  const { tenant, tenantId, emp } = found;
  await mcpCtx.run({ user: { tenantId } }, async () => {
    const existing = await prisma.employmentPeriod.findMany({
      where: { employeeId: emp.id },
      orderBy: { startDate: "asc" },
      select: { id: true, startDate: true, endDate: true },
    });
    const open = existing.filter((p) => p.endDate === null);
    const anchor = emp.hire_date || emp.joining_date;

    console.log(
      `  ${WRITE ? "+" : "."} ${tenant.padEnd(8)} ${String(emp.employee_code).padEnd(8)} ` +
        `${String(emp.employee_name).slice(0, 20).padEnd(20)} status=${String(emp.status).padEnd(8)} ` +
        `periods=${existing.length} open=${open.length} ` +
        `close->${item.closeOn}${item.reopenOn ? ` reopen->${item.reopenOn}` : ""}`,
    );

    if (!WRITE) return;

    if (open.length) {
      // Close every open spell, not just the newest: two open rows would
      // otherwise keep paying after the closing one ends.
      await prisma.employmentPeriod.updateMany({
        where: { employeeId: emp.id, endDate: null },
        data: { endDate: day(item.closeOn), reason: item.closeReason },
      });
    } else if (anchor) {
      // No backfilled row (the migration skips employees with no hire_date):
      // create the historical spell so the closure means something.
      await prisma.employmentPeriod.create({
        data: {
          tenantId, employeeId: emp.id,
          startDate: anchor, endDate: day(item.closeOn), reason: item.closeReason,
        },
      });
    } else {
      console.log(`      ! ${emp.employee_code} has no hire_date; cannot open a historical period`);
    }

    if (item.reopenOn) {
      const already = existing.some(
        (p) => p.startDate && p.startDate.toISOString().slice(0, 10) === item.reopenOn,
      );
      if (!already) {
        await prisma.employmentPeriod.create({
          data: {
            tenantId, employeeId: emp.id,
            startDate: day(item.reopenOn), endDate: null, reason: item.reopenReason,
          },
        });
      }
    }

    if (item.deactivate && emp.status === "active") {
      await prisma.employee.updateMany({
        where: { id: emp.id },
        data: { status: "inactive", employement_status: "Inactive" },
      });
    }
    if (item.reopenOn && emp.status !== "active") {
      await prisma.employee.updateMany({
        where: { id: emp.id },
        data: { status: "active", employement_status: "Active" },
      });
    }
  });
}

console.log(
  failures
    ? `\n${failures} employee(s) unresolved — nothing written for those.`
    : WRITE
      ? "\nemployment periods written"
      : "\nDry run. Re-run with --write to commit.",
);
await prisma.$disconnect().catch(() => {});
