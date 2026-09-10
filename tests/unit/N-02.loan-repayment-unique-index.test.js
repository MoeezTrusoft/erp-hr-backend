// A4 (plan 25) / T-1.2 backfill — [N-02] the (loanId, payrollRunId) idempotency
// index must be UNIQUE. Plan 20 gated the uniqueness on the T-1.3 prod
// reconciliation, which is now clean (doc 24 §2: 0 duplicate pairs fleet-wide —
// gate passed 2026-09-10). The Prisma schema cannot express a partial UNIQUE
// @@index, so the production truth is the deployment SQL; this suite pins that
// contract (F-DB-06-08-14 pattern) so a drift back to non-unique fails CI.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sqlPath = path.join(root, "scripts/sql/N-02.loan-repayment-unique-index.sql");

describe("[N-02] loan_repayments (loanId, payrollRunId) uniqueness contract", () => {
  const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf8") : "";

  test("deployment SQL exists (the uniqueness backfill is shipped)", () => {
    expect(existsSync(sqlPath)).toBe(true);
  });

  test("creates a PARTIAL UNIQUE index excluding legacy NULL-run rows", () => {
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+(CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+"loan_repayments_loanId_payrollRunId_uniq"\s+ON\s+"loan_repayments"\s+\("loanId",\s*"payrollRunId"\)\s+WHERE\s+"payrollRunId"\s+IS\s+NOT\s+NULL;/,
    );
  });

  test("drops the superseded non-unique lookup index (no duplicate pair)", () => {
    expect(sql).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+"loan_repayments_loanId_payrollRunId_idx";/,
    );
  });

  test("guards the rebuild: duplicate check must precede the unique index", () => {
    const dupIdx = sql.indexOf("loan_repayments_loanId_payrollRunId_uniq");
    const guardIdx = sql.indexOf("GROUP BY");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(dupIdx);
  });
});
