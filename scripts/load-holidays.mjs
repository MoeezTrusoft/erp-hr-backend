// scripts/load-holidays.mjs — HR-HOL-01
//
// Populate a holiday calendar. The models and the resolver already work:
// resolveWorkingDays reads employee_holiday_calendars, falls back to every
// holiday in the tenant when nobody is assigned a calendar, and returns
// reason "HOLIDAY" — which HR-ATT-STATUS-01 now stores as a HOLIDAY row.
// What was missing was the DATA: not one holiday is loaded, so every public
// holiday currently reads as an ordinary working day and anybody who stayed
// home reads as absent.
//
// Dates are NOT invented here. They come from a JSON file the business owns:
//
//   [ { "date": "2026-08-14", "name": "Independence Day" }, ... ]
//
//   node scripts/load-holidays.mjs holidays-2026.json --created-by EMP214 [--write]
//
// Lunar holidays (Eid, Ashura, Milad un-Nabi) move year to year and are
// announced locally, so hardcoding them would be wrong within twelve months.
//
// Idempotent: a holiday already on the calendar for that date is left alone,
// so re-running adds only what is new.
//
// Dry run unless --write.
import { readFileSync } from "node:fs";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const file = args.find((a) => a.endsWith(".json"));
const createdByCode = args[args.indexOf("--created-by") + 1];

if (!file || !args.includes("--created-by")) {
  console.error("usage: load-holidays.mjs <holidays.json> --created-by <EMPCODE> [--write]");
  process.exit(2);
}

const entries = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(entries) || !entries.length) {
  console.error("holiday file must be a non-empty array of { date, name }");
  process.exit(2);
}
for (const e of entries) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e?.date ?? "") || !e?.name) {
    console.error(`bad entry: ${JSON.stringify(e)} — need { date: "YYYY-MM-DD", name }`);
    process.exit(2);
  }
}

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

await mcpCtx.run({ system: true }, async () => {
  // Holiday.createdById is a required Employee FK, so the loader needs a real
  // person to attribute the change to rather than a magic id.
  const author = await prisma.employee.findFirst({
    where: { employee_code: createdByCode },
    select: { id: true, employee_name: true },
  });
  if (!author) {
    console.error(`--created-by ${createdByCode} not found`);
    process.exit(2);
  }
  console.log(`author: ${createdByCode} ${author.employee_name}\n`);

  for (const [name, tenantId] of Object.entries(TENANTS)) {
    const year = Number(entries[0].date.slice(0, 4));
    let calendar = await prisma.holidayCalendar.findFirst({
      where: { name: `${name} ${year}`, year },
      select: { id: true },
    });

    if (!calendar && WRITE) {
      calendar = await prisma.holidayCalendar.create({
        data: {
          name: `${name} ${year}`,
          description: `Public holidays observed by ${name} (tenant ${tenantId.slice(0, 8)})`,
          year,
          createdById: author.id,
        },
        select: { id: true },
      });
    }

    const existing = calendar
      ? await prisma.holiday.findMany({
          where: { holidayCalendarId: calendar.id },
          select: { date: true },
        })
      : [];
    const have = new Set(existing.map((h) => h.date.toISOString().slice(0, 10)));

    const missing = entries.filter((e) => !have.has(e.date));
    console.log(
      `${name.padEnd(8)} calendar=${calendar?.id ?? "(would create)"} ` +
      `already=${have.size} to add=${missing.length}`,
    );
    for (const e of missing) console.log(`    ${e.date}  ${e.name}`);

    if (!WRITE || !calendar) continue;
    for (const e of missing) {
      await prisma.holiday.create({
        data: {
          holidayCalendarId: calendar.id,
          date: new Date(`${e.date}T00:00:00.000Z`),
          name: e.name,
          description: e.description ?? null,
          fullDay: e.fullDay ?? true,
          createdById: author.id,
        },
      });
    }
  }

  console.log(`\n${WRITE ? "APPLIED" : "dry run"}`);
  if (!WRITE) console.log("Re-run with --write to commit.");
  console.log("Then re-derive the affected range so the days restate as HOLIDAY.");
});

await prisma.$disconnect().catch(() => {});
