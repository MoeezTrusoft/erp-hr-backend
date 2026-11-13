import test from "node:test";
import assert from "node:assert/strict";
import { fixture, prisma } from "./fixtures.mjs";
test(
  "critical defects need independent fresh retests; configuration drift invalidates activation",
  { timeout: 240000 },
  async () => {
    const f = await fixture();
    try {
      let row = await f.cmd("EMP", "save", null, { setup: f.setup });
      row = await f.complete(row);
      const runKey = "S01:" + f.sn;
      const input = {
        title: "Substituted scanner accepted",
        severity: "CRITICAL",
        ownerCode: f.people.EMP.employee_code,
        dueDate: "2099-01-01",
        runKey,
        details: "Wrong serial observed during capture",
        containment: "Station isolated from operational capture",
        resolution: "Serial binding fixed and isolated retest required",
        retestRunKey: runKey,
        evidenceRefs: ["controlled:repair"],
        attachmentRefs: [],
      };
      row = await f.cmd("EMP", "defect_save", row, input);
      const id = row.defects[0].id;
      assert.ok(row.blockers.some((b) => b.includes("open CRITICAL")));
      await assert.rejects(
        f.cmd("HR", "action", row, { action: "CLOSE_DEFECT", defectRef: id }),
        /fresh passed retest/,
      );
      await assert.rejects(
        f.cmd("EMP", "defect_save", row, {
          ...input,
          defectRef: id,
          severity: "LOW",
        }),
        /cannot be downgraded/,
      );
      const original = row.runs.find((r) => r.runKey === runKey);
      const {
        outcome,
        observed,
        startedAt,
        finishedAt,
        witnessCode,
        attempts,
        metrics,
        deviations,
        evidenceRefs,
        attachmentRefs,
      } = original;
      row = await f.cmd("EMP", "run_save", row, {
        run: {
          runKey,
          outcome,
          observed,
          startedAt,
          finishedAt,
          witnessCode,
          attempts,
          metrics,
          deviations,
          evidenceRefs,
          attachmentRefs,
          defectRefs: [id],
        },
      });
      row = await f.cmd("HR", "action", row, {
        action: "CLOSE_DEFECT",
        defectRef: id,
      });
      assert.equal(row.defects[0].state, "CLOSED");
      row = await f.cmd("TECH", "action", row, { action: "ATTEST_TECHNICAL" });
      row = await f.cmd("EMP", "action", row, { action: "SUBMIT" });
      row = await f.cmd("MANAGER", "action", row, {
        action: "RECOMMEND_APPROVAL",
      });
      row = await f.cmd("HR", "action", row, { action: "VERIFY" });
      row = await f.cmd("MGMT", "action", row, { action: "APPROVE" });
      await f.db((tx) =>
        tx.attendanceCaptureDevice.updateMany({
          where: { sn: f.sn },
          data: { timeZone: "UTC" },
        }),
      );
      await assert.rejects(
        f.cmd("IT", "action", row, { action: "ACTIVATE" }),
        /settings changed/,
      );
      row = await f.cmd("MGMT", "action", row, { action: "REVERT" });
      row = await f.cmd("HR", "action", row, { action: "REVERT" });
      row = await f.cmd("EMP", "save", row, { setup: f.setup });
      assert.equal(row.counts.NOT_RUN, row.total);
      assert.equal(row.technicalByCode, null);
    } finally {
      await prisma.$disconnect();
    }
  },
);
