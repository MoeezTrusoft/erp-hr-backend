import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  prisma,
  company,
  other,
  people,
  db,
  as,
  fixture,
  submit,
  act,
  setup,
} from "./fixtures.mjs";
const { registry, requireApproval } =
  await import("../../src/services/approval/adapters.js");
const { actApproval, listApprovals, readApproval } =
  await import("../../src/services/approval/service.js");
const { HR_APPROVAL_KINDS } = await import("@trusoft/contracts/hr-approval");
const { isStagePaused } = await import("../../src/lib/approvalStagePolicy.js");
test(
  "all HR request approval stages through non-owner PostgreSQL, including returns and final effects",
  { timeout: 180000 },
  async (t) => {
    await setup();
    assert.deepEqual(
      Object.keys(registry).sort(),
      [...HR_APPROVAL_KINDS].sort(),
    );
    for (const kind of HR_APPROVAL_KINDS)
      await t.test(
        kind +
          " complete approval, Management return to HR, HR resolution, and audit",
        async () => {
          const s = await fixture(kind);
          // TS-REQUEST-HYBRID-01 — the Level-1 manager stage is PAUSED for
          // ATTENDANCE: a raised anomaly resolution goes straight to HR
          // verification, and the submission's own audit row records the jump.
          const managerPaused = isStagePaused(kind, "LINE_MANAGER");
          let row = await submit(s);
          assert.equal(row.stage, managerPaused ? "HR" : "LINE_MANAGER");
          if (managerPaused) {
            assert.equal(row.history[0].fromStage, "INITIATOR");
            assert.equal(row.history[0].toStage, "HR");
          }
          for (const who of ["HR", "MANAGEMENT", "OTHER", "ADMIN"])
            await assert.rejects(act(who, row, "APPROVE"), (e) =>
              [403, 404].includes(e.status),
            );
          await assert.rejects(
            act("EMPLOYEE", row, "RECOMMEND_APPROVAL"),
            (e) => e.status === 403,
          );
          if (!managerPaused) {
            row = await act("MANAGER", row, "RECOMMEND_REJECTION");
            assert.equal(row.stage, "HR");
          }
          row = await act("HR", row, "VERIFY");
          assert.equal(row.stage, "MANAGEMENT");
          const before = row;
          row = await act("MANAGEMENT", row, "REVERT");
          assert.equal(row.stage, "HR");
          assert.equal(row.verification, null);
          assert.equal(
            row.recommendation,
            managerPaused ? null : "RECOMMEND_REJECTION",
          );
          await assert.rejects(
            act("MANAGEMENT", before, "APPROVE"),
            (e) => e.status === 412,
          );
          row = await act("HR", row, "VERIFY");
          row = await act("MANAGEMENT", row, "APPROVE");
          assert.equal(row.stage, "APPROVED");
          assert.equal(row.history.length, managerPaused ? 5 : 6);
          assert.equal(row.history[managerPaused ? 2 : 3].toStage, "HR");
          if (
            [
              "ASSESSMENT_RELEASE",
              "DEVELOPMENT",
              "JOB_DESCRIPTION",
              "CATEGORY_CONVERSION",
              "NOTICE_CHANGE",
              "OFFER",
              "SEPARATION_WITHDRAWAL",
              "SETTLEMENT",
            ].includes(kind)
          )
            await db((tx) => requireApproval(tx, company, kind, s.ref));
          else {
            const native = await db((tx) =>
              tx[registry[kind].model].findUnique({ where: { id: s.row.id } }),
            );
            assert.equal(
              native.status ?? native.state,
              kind === "TIME_CREDIT_REVOCATION"
                ? "REVOKED"
                : kind === "LOAN_WRITEOFF"
                  ? "WRITTEN_OFF"
                  : kind === "LOAN"
                    ? "ACTIVE"
                    : kind === "PERFORMANCE"
                      ? "FINALIZED"
                      : "APPROVED",
            );
          }
          if (kind === "OVERTIME")
            assert.equal(
              (
                await db((tx) =>
                  tx.shiftAssignment.findFirst({
                    where: {
                      tenantId: company,
                      employeeId: people.EMPLOYEE.id,
                      date: s.row.date,
                    },
                  }),
                )
              ).overtimeHours,
              2,
            );
          if (kind === "LEAVE")
            assert.equal(
              (
                await db((tx) =>
                  tx.leaveBalance.findUnique({
                    where: {
                      employeeId_leavePolicyId: {
                        employeeId: people.EMPLOYEE.id,
                        leavePolicyId: s.row.leavePolicyId,
                      },
                    },
                  }),
                )
              ).balance,
              19,
            );
          await assert.rejects(
            act("MANAGEMENT", row, "APPROVE"),
            (e) => e.status === 403,
          );
        },
      );
    for (const kind of HR_APPROVAL_KINDS)
      await t.test(
        kind + " manager/HR returns restart review; Management rejects after HR verifies",
        async () => {
          const s = await fixture(kind);
          // TS-REQUEST-HYBRID-01 — with the manager stage paused for ATTENDANCE
          // the first engaged reviewer is HR, so the return comes from HR and
          // still lands on the initiator (HR_REVERT_TARGET) rather than
          // stranding the request in a paused stage.
          const managerPaused = isStagePaused(kind, "LINE_MANAGER");
          let row = await submit(s);
          row = await act(managerPaused ? "HR" : "MANAGER", row, "REVERT");
          assert.equal(row.stage, "INITIATOR");
          row = await submit(s, row.version);
          assert.equal(row.round, 2);
          if (!managerPaused)
            row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
          row = await act("HR", row, "VERIFY");
          row = await act("MANAGEMENT", row, "REVERT");
          row = await act("HR", row, "REVERT");
          assert.equal(row.stage, "INITIATOR");
          assert.equal(row.recommendation, null);
          assert.equal(row.verification, null);
          row = await submit(s, row.version);
          assert.equal(row.round, 3);
          if (!managerPaused)
            row = await act("MANAGER", row, "RECOMMEND_REJECTION");
          // Operator 2026-11-01: HR may reject outright (covered in hrReject.postgres.test.mjs), except an
          // attendance case, which payroll prices only when Management disapproves it.
          if (kind === "ATTENDANCE")
            await assert.rejects(
              act("HR", row, "REJECT"),
              (e) => e.status === 403,
            );
          row = await act("HR", row, "VERIFY");
          row = await act("MANAGEMENT", row, "REJECT");
          assert.equal(row.stage, "REJECTED");
          assert.ok(row.history.length > (managerPaused ? 8 : 10));
        },
      );
    await t.test(
      "employee withdrawals close the native request and all reviewer queues",
      async () => {
        const { legacyWithdraw } =
          await import("../../src/services/approval/legacy.js");
        for (const kind of ["LEAVE", "OVERTIME", "CLAIM", "SHIFT_SWAP"])
          for (const stage of [
            "LINE_MANAGER",
            "HR",
            "MANAGEMENT",
            "INITIATOR",
          ]) {
            const source = await fixture(kind);
            let row = await submit(source);
            if (stage === "INITIATOR")
              row = await act("MANAGER", row, "REVERT");
            if (["HR", "MANAGEMENT"].includes(stage))
              row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
            if (stage === "MANAGEMENT") row = await act("HR", row, "VERIFY");
            await assert.rejects(act("HR", row, "WITHDRAW"), (e) =>
              [403, 404].includes(e.status),
            );
            const result = await as("EMPLOYEE", () =>
              legacyWithdraw(
                kind,
                source.ref,
                "Employee no longer requires this request",
              ),
            );
            assert.equal(
              result.status,
              kind === "LEAVE" ? "CANCELLED" : "WITHDRAWN",
            );
            const current = (
              await as("EMPLOYEE", () =>
                readApproval({ approvalRef: row.approvalRef }),
              )
            ).record;
            assert.equal(current.stage, "WITHDRAWN");
            assert.deepEqual(current.actions, []);
            assert.equal(
              current.history.at(-1).actorCode,
              people.EMPLOYEE.employee_code,
            );
            await assert.rejects(
              act("MANAGEMENT", current, "APPROVE"),
              (e) => e.status === 403,
            );
            assert.ok(
              !(
                await as("HR", () => listApprovals({ scope: "QUEUE", kind }))
              ).items.some((r) => r.approvalRef === row.approvalRef),
            );
          }
        const draft = await fixture("CLAIM");
        await assert.rejects(
          as("OTHER", () => legacyWithdraw("CLAIM", draft.ref)),
          (e) => e.status === 403,
        );
        assert.equal(
          (await as("EMPLOYEE", () => legacyWithdraw("CLAIM", draft.ref)))
            .status,
          "WITHDRAWN",
        );
      },
    );
    await t.test(
      "offer delivery requires approved source facts and preserves the native send operation",
      async () => {
        const { sendOffer } =
          await import("../../src/services/offer.service.js");
        const source = await fixture("OFFER");
        await assert.rejects(
          as("HR", () => sendOffer(source.row.id, company)),
          /Complete the employee/,
        );
        let row = await submit(source);
        row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
        row = await act("HR", row, "VERIFY");
        await act("MANAGEMENT", row, "APPROVE");
        const sent = await as("HR", () => sendOffer(source.row.id, company));
        assert.equal(sent.status, "SENT");
      },
    );
    await t.test('concurrent expense-line edits cannot cross a final approval',async()=>{
      const source=await fixture('CLAIM');let row=await submit(source);row=await act('MANAGER',row,'RECOMMEND_APPROVAL');row=await act('HR',row,'VERIFY');
      let release,ready;const edited=new Promise(resolve=>{ready=resolve;}),hold=new Promise(resolve=>{release=resolve;});
      const mutation=db(async tx=>{await tx.claimItem.updateMany({where:{tenantId:company,claimId:source.row.id},data:{amount:150}});ready();await hold;});
      await edited;const decision=act('MANAGEMENT',row,'APPROVE');release();await mutation;await assert.rejects(decision,/evidence changed/);
      assert.equal((await as('HR',()=>readApproval({approvalRef:row.approvalRef}))).record.stage,'MANAGEMENT');
    });
    await t.test(
      "changed facts, role isolation, request-key replay, audit immutability and RLS",
      async () => {
        const s = await fixture("CLAIM");
        let row = await submit(s);
        await db((tx) =>
          tx.reimbursementClaim.update({
            where: { id: s.row.id },
            data: { amount: 140 },
          }),
        );
        await assert.rejects(
          act("MANAGER", row, "RECOMMEND_APPROVAL"),
          /evidence changed/,
        );
        row = await act("MANAGER", row, "REVERT");
        row = await submit(s, row.version);
        const input = {
          approvalRef: row.approvalRef,
          expectedVersion: row.version,
          action: "RECOMMEND_APPROVAL",
          reason: "Checked receipts",
          requestKey: randomUUID(),
        };
        const [one, two] = await Promise.all([
          as("MANAGER", () => actApproval(input)),
          as("MANAGER", () => actApproval(input)),
        ]);
        assert.deepEqual(one, two);
        await assert.rejects(
          as("HR", () => actApproval(input)),
          /another command/,
        );
        await assert.rejects(
          as("OTHER", () => readApproval({ approvalRef: row.approvalRef })),
          (e) => e.status === 404,
        );
        await assert.rejects(
          as(
            "EMPLOYEE",
            () => readApproval({ approvalRef: row.approvalRef }),
            other,
          ),
          (e) => [403, 404].includes(e.status),
        );
        await assert.rejects(
          db((tx) =>
            tx.hrApprovalAudit.deleteMany({
              where: { tenantId: company, approvalRef: row.approvalRef },
            }),
          ),
          /immutable/,
        );
        await assert.rejects(
          db((tx) =>
            tx.reimbursementClaim.update({
              where: { id: s.row.id },
              data: { status: "APPROVED" },
            }),
          ),
          /staged approval/,
        );
        const stored = await db((tx) =>
          tx.hrApprovalRequest.findUnique({ where: { id: row.approvalRef } }),
        );
        assert.ok(stored.snapshot.sealed.startsWith("c4."));
        assert.equal(stored.snapshot.amount, undefined);
        const mine = await as("EMPLOYEE", () =>
          listApprovals({ scope: "MINE", kind: "CLAIM" }),
        );
        assert.ok(mine.items.some((i) => i.approvalRef === row.approvalRef));
      },
    );
    await t.test(
      "REST and MCP produce identical scoped records and reject injected authority",
      async () => {
        const { approvalController } =
          await import("../../src/controllers/approval.controller.js");
        const { registerApprovalTools } =
          await import("../../src/mcp/tools/approvalTools.js");
        const s = await fixture("CLAIM"),
          row = await submit(s),
          handlers = {};
        registerApprovalTools({
          registerTool: (name, _schema, fn) => {
            handlers[name] = fn;
          },
        });
        const input = { approvalRef: row.approvalRef };
        let rest, error;
        await as("EMPLOYEE", () =>
          approvalController("hr_approval_read")(
            { body: input },
            {
              json: (data) => {
                rest = data;
              },
            },
            (e) => {
              error = e;
            },
          ),
        );
        assert.equal(error, undefined);
        const mcp = await as("EMPLOYEE", () =>
          handlers.hr_approval_read(input),
        );
        assert.deepEqual(rest, mcp.structuredContent);
        await as("EMPLOYEE", () =>
          approvalController("hr_approval_read")(
            { body: { ...input, employeeId: people.OTHER.id } },
            { json: () => assert.fail("Invalid input accepted") },
            (e) => {
              error = e;
            },
          ),
        );
        assert.ok(error);
        assert.ok(!JSON.stringify(rest.record.source).includes("employeeId"));
      },
    );
    await t.test(
      "failed final effects roll back the decision, history, outbox and replay receipt",
      async () => {
        const s = await fixture("OVERTIME");
        let row = await submit(s);
        row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
        row = await act("HR", row, "VERIFY");
        await db((tx) =>
          tx.shiftAssignment.deleteMany({
            where: {
              tenantId: company,
              employeeId: people.EMPLOYEE.id,
              date: s.row.date,
            },
          }),
        );
        const requestKey = randomUUID();
        await assert.rejects(
          act("MANAGEMENT", row, "APPROVE", { requestKey }),
          /Configure the roster/,
        );
        const fresh = await as("MANAGEMENT", () =>
          readApproval({ approvalRef: row.approvalRef }),
        );
        assert.equal(fresh.record.stage, "MANAGEMENT");
        assert.equal(fresh.record.version, row.version);
        assert.equal(fresh.record.history.length, row.history.length);
        assert.equal(
          await db((tx) =>
            tx.hrApprovalReceipt.count({
              where: { tenantId: company, requestKey },
            }),
          ),
          0,
        );
        assert.equal(
          (
            await db((tx) =>
              tx.overtimeRequest.findUnique({ where: { id: s.row.id } }),
            )
          ).status,
          "PENDING",
        );
      },
    );
    await t.test(
      "a changed manager needs a new recommendation and revoked permissions cannot replay a receipt",
      async () => {
        const { mcpCtx } = await import("../../src/mcp/context.js");
        const s = await fixture("CLAIM");
        let row = await submit(s);
        const input = {
          approvalRef: row.approvalRef,
          expectedVersion: row.version,
          action: "RECOMMEND_APPROVAL",
          reason: "Checked receipts",
          requestKey: randomUUID(),
        };
        row = (await as("MANAGER", () => actApproval(input))).record;
        await assert.rejects(
          mcpCtx.run(
            {
              actorVerified: true,
              user: { tenantId: company, userId: people.MANAGER.userId },
              permissions: ["hr.approvals.self"],
            },
            () => actApproval(input),
          ),
          (e) => e.status === 403,
        );
        await db((tx) =>
          tx.employee.update({
            where: { id: people.EMPLOYEE.id },
            data: { managerId: people.OTHER.id },
          }),
        );
        try {
          await assert.rejects(
            act("HR", row, "VERIFY"),
            /line manager changed/,
          );
          row = await act("HR", row, "REVERT");
          assert.equal(row.stage, "INITIATOR");
        } finally {
          await db((tx) =>
            tx.employee.update({
              where: { id: people.EMPLOYEE.id },
              data: { managerId: people.MANAGER.id },
            }),
          );
        }
      },
    );
    await t.test(
      "approved expense lines are frozen and legacy direct decisions cannot write",
      async () => {
        const { legacyDecision, legacySubmit } =
          await import("../../src/services/approval/legacy.js");
        const s = await fixture("CLAIM");
        await assert.rejects(
          as("MANAGER", () => legacyDecision("CLAIM", s.ref)),
          (e) => e.status === 409 && e.code === "HR-4201",
        );
        const legacy = await as("EMPLOYEE", () => legacySubmit("CLAIM", s.ref));
        assert.equal(legacy.id, s.row.id);
        assert.equal(legacy.status, "SUBMITTED");
        let row = (
          await as("EMPLOYEE", () =>
            listApprovals({ kind: "CLAIM", scope: "MINE" }),
          )
        ).items.find((r) => r.sourceRef === s.ref);
        row = await act("MANAGER", row, "RECOMMEND_APPROVAL");
        row = await act("HR", row, "VERIFY");
        await act("MANAGEMENT", row, "APPROVE");
        await assert.rejects(
          db((tx) =>
            tx.claimItem.updateMany({
              where: { tenantId: company, claimId: s.row.id },
              data: { amount: 999 },
            }),
          ),
          /Approved request lines are immutable/,
        );
        await assert.rejects(
          db((tx) =>
            tx.claimItem.deleteMany({
              where: { tenantId: company, claimId: s.row.id },
            }),
          ),
          /Approved request lines are immutable/,
        );
      },
    );
  },
);
test.after(() => prisma.$disconnect());
