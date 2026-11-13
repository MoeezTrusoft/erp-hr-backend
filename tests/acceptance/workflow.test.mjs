import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, prisma } from "./fixtures.mjs";
test(
  "seven-site acceptance enforces evidence, stage independence, reverts and guarded activation",
  { timeout: 240000 },
  async (t) => {
    const f = await fixture();
    try {
      assert.equal((await f.call("EMP", "overview")).sites.length, 7);
      await assert.rejects(
        f.call("ADMIN", "overview"),
        /Requires hr.setup.read/,
      );
      let row = await f.cmd("EMP", "save", null, { setup: f.setup });
      assert.equal(row.state, "DRAFT");
      assert.equal(row.counts.NOT_RUN, row.total);
      await assert.rejects(
        f.cmd("IT", "action", row, { action: "ACTIVATE" }),
        /not permitted/,
      );
      await assert.rejects(
        f.cmd("EMP", "action", row, { action: "SUBMIT" }),
        /Acceptance blocked/,
      );
      await assert.rejects(
        f.cmd("EMP", "run_save", row, {
          run: {
            runKey: "S01:" + f.sn,
            outcome: "NA",
            observed: "Unavailable",
            witnessCode: f.people.MANAGER.employee_code,
            evidenceRefs: ["controlled:test"],
          },
        }),
        /cannot be N\/A/,
      );
      const stale = row;
      row = await f.cmd("EMP", "evidence_upload", row, {
        runKey: "SITE",
        fileName: "test-evidence.pdf",
        contentBase64: Buffer.from("%PDF-1.4\ncontrolled evidence").toString(
          "base64",
        ),
      });
      assert.equal(row.attachments.length, 1);
      const evidenceRef = row.attachments[0].evidenceRef;
      assert.equal(
        (await f.call("HR", "evidence_read", { evidenceRef })).evidence
          .fileName,
        "test-evidence.pdf",
      );
      await assert.rejects(
        f.cmd("EMP", "save", stale, { setup: f.setup }),
        /changed/,
      );
      await assert.rejects(
        f.cmd("EMP", "evidence_upload", row, {
          fileName: "bad.pdf",
          contentBase64: Buffer.from("not a PDF").toString("base64"),
        }),
        /Supported evidence/,
      );
      row = await f.complete(row);
      assert.equal(row.blockers.length, 0);
      row = await f.cmd("TECH", "action", row, { action: "ATTEST_TECHNICAL" });
      row = await f.cmd("EMP", "action", row, { action: "SUBMIT" });
      assert.equal(row.state, "LINE_MANAGER");
      await assert.rejects(
        f.cmd("EMP", "save", row, { setup: f.setup }),
        /Return the package/,
      );
      row = await f.cmd("MANAGER", "action", row, { action: "REVERT" });
      assert.equal(row.state, "DRAFT");
      row = await f.cmd("EMP", "action", row, { action: "SUBMIT" });
      row = await f.cmd("MANAGER", "action", row, {
        action: "RECOMMEND_APPROVAL",
      });
      assert.equal(row.state, "HR");
      f.grants.EMP.push("hr.approvals.verify", "hr.setup.approve");
      await assert.rejects(
        f.cmd("EMP", "action", row, { action: "VERIFY" }),
        /not permitted/,
      );
      row = await f.cmd("HR", "action", row, { action: "VERIFY" });
      assert.equal(row.state, "MANAGEMENT");
      row = await f.cmd("MGMT", "action", row, { action: "REVERT" });
      assert.equal(row.state, "HR");
      assert.equal(row.verifiedByCode, null);
      row = await f.cmd("HR", "action", row, { action: "REVERT" });
      assert.equal(row.state, "DRAFT");
      row = await f.cmd("EMP", "action", row, { action: "SUBMIT" });
      row = await f.cmd("MANAGER", "action", row, {
        action: "RECOMMEND_REJECTION",
      });
      row = await f.cmd("HR", "action", row, { action: "VERIFY" });
      row = await f.cmd("MGMT", "action", row, { action: "APPROVE" });
      await f.db((tx) =>
        tx.employee.update({
          where: { id: f.people.EMP.id },
          data: { managerId: f.people.TECH.id },
        }),
      );
      await assert.rejects(
        f.cmd("IT", "action", row, { action: "ACTIVATE" }),
        /Reporting line or account link changed/,
      );
      await f.db((tx) =>
        tx.employee.update({
          where: { id: f.people.EMP.id },
          data: { managerId: f.people.MANAGER.id },
        }),
      );
      await assert.rejects(
        f.db((tx) =>
          tx.attendanceCaptureDevice.updateMany({
            where: { sn: f.sn },
            data: { active: true },
          }),
        ),
        /onsite acceptance required/,
      );
      row = await f.cmd("IT", "action", row, { action: "ACTIVATE" });
      assert.equal(row.state, "ACTIVE");
      const device = await f.db((tx) =>
        tx.attendanceCaptureDevice.findFirst({ where: { sn: f.sn } }),
      );
      assert.equal(device.active, true);
      assert.equal(device.acceptanceMode, "SUPERVISED");
      row = await f.cmd("IT", "action", row, { action: "SUSPEND" });
      assert.equal(row.state, "SUSPENDED");
      assert.equal(
        (
          await f.db((tx) =>
            tx.attendanceCaptureDevice.findFirst({ where: { sn: f.sn } }),
          )
        ).active,
        false,
      );
      row = await f.cmd("EMP", "action", row, { action: "REOPEN" });
      const key = randomUUID(),
        input = {
          slot: "S01",
          expectedVersion: row.version,
          requestKey: key,
          reason: "Idempotent setup save",
          setup: f.setup,
        };
      const one = await f.call("EMP", "save", input),
        two = await f.call("EMP", "save", input);
      assert.equal(one.record.version, two.record.version);
      await assert.rejects(
        f.call("EMP", "save", { ...input, reason: "Changed command" }),
        /Request key/,
      );
      await assert.rejects(
        f.db((tx) =>
          tx.attendanceAcceptanceAudit.deleteMany({
            where: { siteRef: row.siteRef },
          }),
        ),
        /append-only|immutable|cannot/i,
      );
      const other = await fixture();
      await assert.rejects(
        other.call("EMP", "evidence_read", { evidenceRef }),
        /not found/,
      );
      const history = (await f.call("HR", "read", { slot: "S01" })).record
        .history;
      assert.ok(history.some((a) => a.action === "ACTIVATE"));
      assert.ok(history.every((a) => !("actorUserId" in a)));
    } finally {
      await prisma.$disconnect();
    }
  },
);
