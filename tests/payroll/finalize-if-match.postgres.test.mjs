import test from "node:test";
import assert from "node:assert/strict";
import {
  setupPayroll,
  prisma,
  company,
  people,
  as,
  submit,
  act,
} from "./fixtures.mjs";
import {
  processPayrollRun,
  finalizePayrollRun,
  getPayrollRunById,
} from "../../src/services/payrollService.js";

test(
  "finalize honours If-Match against the run version clients read",
  { timeout: 180000 },
  async () => {
    const { run } = await setupPayroll();
    await as("EMPLOYEE", () =>
      processPayrollRun(run.id, people.EMPLOYEE.id, company),
    );
    let review = await submit({ kind: "PAYROLL", ref: String(run.id) });
    review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
    review = await act("HR", review, "VERIFY");
    await act("MANAGEMENT", review, "APPROVE");

    const read = await as("HR", () => getPayrollRunById(run.id, company));
    assert.equal(read.status, "APPROVED");
    assert.ok(Number.isInteger(read.version) && read.version > 0);

    await assert.rejects(
      as("HR", () =>
        finalizePayrollRun(run.id, people.HR.id, company, {
          ifMatch: `"${read.version - 1}"`,
        }),
      ),
      (error) => error.status === 412,
    );
    const finalized = await as("HR", () =>
      finalizePayrollRun(run.id, people.HR.id, company, {
        ifMatch: `"${read.version}"`,
      }),
    );
    assert.equal(finalized.status, "FINALIZED");
    // A retry carrying the pre-finalize version is an idempotent replay.
    const replay = await as("HR", () =>
      finalizePayrollRun(run.id, people.HR.id, company, {
        ifMatch: `"${read.version}"`,
      }),
    );
    assert.equal(replay.status, "FINALIZED");
    await prisma.$disconnect();
  },
);
