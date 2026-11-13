// scripts/seed-fbr-slabs-2026-27.mjs — HR-PAYROLL-FBR-SLABS-01
//
// Pakistan salaried income-tax slabs, tax year 2026-27 (effective 2026-07-01).
// Without these every payslip prints "Income Tax 0.00".
//
// MONTHLY BRACKETS, NOT ANNUAL. computeProgressiveTaxMinor applies brackets
// directly to the payslip's gross, which is a MONTH's gross, with no
// annualisation. So each FBR annual threshold is divided by 12.
//
//   annual band                rate   monthly band
//           0 –    600,000       0%          0 –  50,000
//     600,000 –  1,200,000       1%     50,000 – 100,000
//   1,200,000 –  2,200,000      11%    100,000 – 183,333.33
//   2,200,000 –  3,200,000      20%    183,333.33 – 266,666.67
//   3,200,000 –  4,100,000      25%    266,666.67 – 341,666.67
//   4,100,000 –  5,600,000      29%    341,666.67 – 466,666.67
//   5,600,000 –  7,000,000      32%    466,666.67 – 583,333.33
//   7,000,000 +                35%    583,333.33 +
//
// The engine sums marginal slices, which reproduces FBR's "PKR 6,000 plus 11%"
// presentation exactly: 1% of the 600k–1.2m band IS 6,000. baseTax is stored
// for the Payroll Setup UI only — the calculation does not read it.
//
// LIMITATION worth knowing: taxing each month independently equals the annual
// result only while monthly pay is constant. A bonus month is over-taxed
// relative to an annual reconciliation. Real annualisation would need the
// engine to project yearly income; not attempted here.
//
// Dry run unless --write. Idempotent: a tenant that already has PK slabs
// effective on this date is skipped.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");
const EFFECTIVE_FROM = new Date("2026-07-01T00:00:00.000Z");

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const M = (annual) => Number((annual / 12).toFixed(4));

// [annualMin, annualMax|null, ratePct, annualBaseTax]
const ANNUAL = [
  [0, 600_000, 0, 0],
  [600_000, 1_200_000, 1, 0],
  [1_200_000, 2_200_000, 11, 6_000],
  [2_200_000, 3_200_000, 20, 116_000],
  [3_200_000, 4_100_000, 25, 316_000],
  [4_100_000, 5_600_000, 29, 541_000],
  [5_600_000, 7_000_000, 32, 976_000],
  [7_000_000, null, 35, 1_424_000],
];

// The published "plus PKR X" figures must equal the sum of the lower slices, or
// the table has been transcribed wrong.
let cumulative = 0;
ANNUAL.forEach(([lo, hi, pct, baseTax], i) => {
  if (Math.abs(cumulative - baseTax) > 0.5) {
    throw new Error(`slab ${i}: baseTax ${baseTax} != cumulative ${cumulative}`);
  }
  if (hi != null) cumulative += ((hi - lo) * pct) / 100;
});

async function main() {
  console.log(`FBR TY2026-27 salaried slabs${WRITE ? "" : "   (DRY RUN)"}`);
  console.log(`monthly brackets, effective ${EFFECTIVE_FROM.toISOString().slice(0, 10)}\n`);

  for (const [name, tenantId] of Object.entries(TENANTS)) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const existing = await prisma.taxRate.count({
        where: { tenantId, countryCode: "PK", effectiveFrom: EFFECTIVE_FROM },
      });
      if (existing > 0) {
        console.log(`${name.padEnd(8)} already has ${existing} PK slabs for this date — skipped`);
        return;
      }

      for (const [lo, hi, pct, baseTax] of ANNUAL) {
        const row = {
          tenantId,
          countryCode: "PK",
          bracketMin: M(lo),
          bracketMax: hi == null ? null : M(hi),
          rate: pct / 100,
          baseTax: M(baseTax),
          effectiveFrom: EFFECTIVE_FROM,
        };
        if (WRITE) await prisma.taxRate.create({ data: row });
      }
      console.log(
        `${name.padEnd(8)} ${WRITE ? "wrote" : "would write"} ${ANNUAL.length} slabs ` +
          `(0% up to ${M(600_000).toLocaleString()}/mo, top 35% above ${M(7_000_000).toLocaleString()}/mo)`,
      );
    });
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");
}

try {
  await main();
} finally {
  await prisma.$disconnect().catch(() => {});
}
process.exit(0);
