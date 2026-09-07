// scripts/set-sheet-aliases.mjs — HR-IMPORT-01
//
// Record the workbook labels that were resolved BY HAND this month, so the next
// reconciliation is a lookup instead of a judgement call.
//
// Every one of these needed a human: "G Rasool" fuzzily matched Abdul Rasool
// Junejo as well; "Hasaam", "Shokat", "Jafri" and "Jamshed" matched nobody
// because the stop-word list ate their only distinguishing token; "M. Yaseen"
// is two people and could only be separated by tenant and shift times.
//
// Also audits every roster against HR-ROSTER-03, since a pattern that cannot be
// read is the other half of the same problem — a silent wrong answer nobody is
// told about.
//
//   node scripts/set-sheet-aliases.mjs [--write]
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { validateSchedulePattern } from "../src/lib/schedulePattern.js";

const WRITE = process.argv.includes("--write");

// code -> the label HR's sheet heads their column with.
const ALIASES = {
  EMP162: "G Rasool",
  EMP158: "Abdul Rasool",
  EMP182: "Hasaam",
  EMP199: "Shokat",
  EMP157: "Jafri",
  EMP184: "Jamshed",
  EMP187: "Yaseen",
  EMP156: "M. Yaseen",
  EMP214: "Moeez",
  EMP175: "Arsalan Ch",
  EMP191: "M. Arsalan",
  EMP164: "Imran H",
  EMP167: "M. Imran",
  EMP183: "Imam Bux",
  EMP189: "Mola",
  EMP206: "Akash Nanu",
  EMP160: "Akash",
};

await mcpCtx.run({ system: true }, async () => {
  const emps = await prisma.employee.findMany({
    where: { employee_code: { in: Object.keys(ALIASES) } },
    select: { id: true, employee_code: true, employee_name: true, sheet_alias: true },
  });
  const byCode = new Map(emps.map((e) => [e.employee_code, e]));

  console.log("SHEET ALIASES");
  for (const [code, alias] of Object.entries(ALIASES)) {
    const e = byCode.get(code);
    if (!e) { console.log(`  SKIP ${code} — not found`); continue; }
    const change = e.sheet_alias === alias ? "(unchanged)" : `${e.sheet_alias ?? "-"} -> ${alias}`;
    console.log(`  ${code} ${String(e.employee_name).slice(0, 22).padEnd(24)}${change}`);
    if (WRITE && e.sheet_alias !== alias) {
      await prisma.employee.update({ where: { id: e.id }, data: { sheet_alias: alias } });
    }
  }

  // A label that maps to two people is worse than none: it is the case that
  // silently moves attendance onto the wrong payslip.
  const clashes = new Map();
  for (const [code, alias] of Object.entries(ALIASES)) {
    const k = alias.trim().toLowerCase();
    if (!clashes.has(k)) clashes.set(k, []);
    clashes.get(k).push(code);
  }
  for (const [alias, codes] of clashes) {
    if (codes.length > 1) console.log(`  CLASH "${alias}" -> ${codes.join(", ")}`);
  }

  console.log("\nROSTER PATTERN AUDIT (HR-ROSTER-03)");
  const all = await prisma.employee.findMany({
    select: {
      employee_code: true, employee_name: true,
      WorkSchedule: {
        select: { schedule_pattern: true },
        orderBy: { effective_start_date: "desc" }, take: 1,
      },
    },
  });
  let bad = 0;
  for (const e of all.sort((a, b) => String(a.employee_code).localeCompare(String(b.employee_code)))) {
    const p = e.WorkSchedule[0]?.schedule_pattern ?? null;
    const { valid, errors } = validateSchedulePattern(p);
    if (valid) continue;
    bad += 1;
    console.log(`  ${e.employee_code} ${String(e.employee_name).slice(0, 22).padEnd(24)}${errors.join("; ")}`);
  }
  console.log(`  ${bad} of ${all.length} rosters would be refused by the validator`);

  console.log(`\n${WRITE ? "APPLIED" : "dry run"}`);
  if (!WRITE) console.log("Re-run with --write to commit the aliases.");
});

await prisma.$disconnect().catch(() => {});
