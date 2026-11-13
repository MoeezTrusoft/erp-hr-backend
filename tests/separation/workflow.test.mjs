import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Use the isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
const { completeBusinessApproval } = await import("../approval/complete.mjs");
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { employmentHandlers: h } =
  await import("../../src/mcp/tools/separationTools.js");
const { prepareEmployeeInsert, guardIdentityEdit } =
  await import("../../src/services/employee-code.service.js");
const { sweepCompany, processDelivery } =
  await import("../../src/services/separation/automation.js");
const company = randomUUID(),
  other = randomUUID(),
  people = {};
const permissions = [
  "self",
  "manager",
  "read",
  "manage",
  "verify",
  "approve",
  "task",
  "clear",
  "settle",
  "integrate",
]
  .map((p) => "hr.separation." + p)
  .concat("hr.employee_code.manage");
const codes = {
  LEAVER: "EMP-9101",
  MANAGER: "MGMT-9102",
  HR: "MGMT-9103",
  CEO: "MGMT-9104",
  RECEIVER: "EMP-9105",
  OTHER: "EMP-9106",
};
const db = (fn) =>
  mcpCtx.run({ user: { tenantId: company } }, () =>
    tenantTransaction(prisma, fn, { tenantId: company }),
  );
const as = (key, fn, perms = permissions, tenantId = company) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId, userId: people[key].userId, isAdmin: false },
      permissions: perms,
    },
    fn,
  );
const call = (key, name, input, perms) =>
  as(
    key,
    () => h[name]({ ...input, requestKey: input.requestKey || randomUUID() }),
    perms,
  );
const command = async (key, name, s, input = {}) => {
  const fresh = await db((tx) =>
    tx.separation.findUnique({ where: { id: s.ref } }),
  );
  return call(key, name, {
    employeeCode: fresh.employeeCode,
    separationRef: s.ref,
    expectedVersion: fresh.version,
    ...input,
  });
};
const taskRows = async (s, model) =>
  db((tx) =>
    tx[model].findMany({ where: { tenantId: company, separationRef: s.ref } }),
  );
const taskCommand = async (key, name, s, model, row, input = {}) =>
  command(key, name, s, {
    taskRef: row.id,
    taskVersion: row.version,
    evidenceRefs: ["fictional-evidence:01"],
    ...input,
  });
let policy;
test(
  "employee identity and separation security through real PostgreSQL",
  { timeout: 120000 },
  async (t) => {
    await db(async (tx) => {
      const grade = await tx.gradeLevel.create({
        data: { tenantId: company, name: "G1" },
      });
      for (const [key, code] of Object.entries(codes))
        people[key] = await tx.employee.create({
          data: {
            tenant_id: company,
            employee_code: code,
            employeeCategory: code.startsWith("MGMT")
              ? "MANAGEMENT"
              : "EMPLOYEE",
            first_name: "Fictional",
            last_name: key,
            status: "Active",
            employement_status: "Active",
            userId: 100000 + Math.floor(Math.random() * 1e8),
            gradeLevelId: grade.id,
          },
        });
      for (const key of ["LEAVER", "OTHER", "RECEIVER"])
        await tx.employee.update({
          where: { id: people[key].id },
          data: { managerId: people.MANAGER.id },
        });
      await tx.employee.update({
        where: { id: people.MANAGER.id },
        data: { managerId: people.CEO.id },
      });
    });
    policy = {
      timeZone: "Asia/Karachi",
      typeRules: [
        "RESIGNATION",
        "TERMINATION_WITH_CAUSE",
        "TERMINATION_WITHOUT_CAUSE",
        "CONTRACT_END",
        "INTERNSHIP_COMPLETION",
        "RETIREMENT",
        "MUTUAL_SEPARATION",
        "DEATH_IN_SERVICE",
      ].map((type) => ({
        type,
        initiators: type === "RESIGNATION" ? ["SELF", "HR"] : ["MANAGER", "HR"],
        requiredDocumentKinds: [],
        noticeTreatment: type === "RESIGNATION" ? "CONTRACT_OR_GRADE" : "NONE",
        allowPostApprovalWithdrawal: true,
      })),
      noticeByGrade: [{ category: "EMPLOYEE", gradeCode: "G1", days: 2 }],
      authority: [
        { category: "EMPLOYEE", gradeCode: "G1", approverCodes: [codes.CEO] },
        { category: "MANAGEMENT", gradeCode: "G1", approverCodes: [codes.CEO] },
      ],
      clearanceDepartments: [
        { departmentCode: "HR", ownerCode: codes.HR, signerCodes: [codes.HR] },
        {
          departmentCode: "IT",
          ownerCode: codes.RECEIVER,
          signerCodes: [codes.RECEIVER],
        },
      ],
      hrCodes: [codes.HR],
      itOwnerCode: codes.RECEIVER,
      payrollOwnerCode: codes.HR,
      templates: ["ACCEPTANCE", "TERMINATION", "CLEARANCE", "EXPERIENCE"].map(
        (kind) => ({
          kind,
          approvedRef: "fictional-template:" + kind,
          body: "Fictional approved letter {{employeeCode}} {{lastWorkingAt}} {{type}}",
        }),
      ),
      settlement: {
        currency: "PKR",
        minorUnits: 2,
        leaveEncashment: true,
        noticeRecovery: true,
        noticePay: false,
      },
      reminderDays: 5,
    };
    // Existing separation scenarios start with an already approved policy.
    // Company setup's dedicated integration suite tests the full review path.
    await db(async (tx) => {
      const review = await tx.hrSetupReview.create({
        data: {
          tenantId: company,
          kind: "POLICY",
          subjectKey: "POLICY",
          state: "APPROVED",
          payload: { fixture: true },
          source: { fixture: true },
          contentHash: "fixture-policy",
          preparedByCode: people.HR.employee_code,
          preparedByUserId: people.HR.userId,
          editorUserIds: [people.HR.userId],
          approvedByCode: people.CEO.employee_code,
          approvedByUserId: people.CEO.userId,
          approvedHash: "fixture-policy",
          approvedAt: new Date(),
        },
      });
      await tx.$executeRaw`SELECT set_config('app.hr_setup_review',${review.id},true)`;
      await tx.separationPolicy.create({
        data: {
          tenantId: company,
          policy,
          actorCode: people.HR.employee_code,
          approvalReviewRef: review.id,
        },
      });
    });
    await t.test(
      "concurrent hires allocate unique codes before insert and DB rejects blanks",
      async () => {
        const rows = await Promise.all(
          Array.from({ length: 8 }, () =>
            db(async (tx) =>
              tx.employee.create({
                data: await prepareEmployeeInsert(
                  tx,
                  { first_name: "Fictional", status: "Active" },
                  { tenantId: company, category: "INTERNEE" },
                ),
              }),
            ),
          ),
        );
        assert.equal(new Set(rows.map((x) => x.employee_code)).size, 8);
        assert.ok(rows.every((x) => /^INTR-\d{4}$/.test(x.employee_code)));
        await assert.rejects(
          db((tx) =>
            tx.employee.create({
              data: {
                tenant_id: company,
                employee_code: "",
                employeeCategory: "EMPLOYEE",
              },
            }),
          ),
          /HR-4601/,
        );
        await assert.rejects(
          db((tx) =>
            tx.employee.create({
              data: {
                tenant_id: company,
                employee_code: "emp-9999",
                employeeCategory: "EMPLOYEE",
              },
            }),
          ),
          /HR-4602/,
        );
        await assert.rejects(
          db((tx) =>
            tx.employee.create({
              data: {
                tenant_id: company,
                employee_code: "EMP_9101",
                employeeCategory: "EMPLOYEE",
              },
            }),
          ),
          /collision|Unique constraint/i,
        );
      },
    );
    await t.test(
      "category conversion requires independent approval, aliases and immutable reservations",
      async () => {
        const who = await db((tx) =>
          tx.employee.findUnique({ where: { id: people.OTHER.id } }),
        );
        assert.throws(() =>
          guardIdentityEdit(who, { employeeCategory: "MANAGEMENT" }),
        );
        const requested = await call("HR", "hr_employee_category_convert", {
          employeeCode: codes.OTHER,
          expectedVersion: who.version,
          action: "REQUEST",
          category: "MANAGEMENT",
          effectiveAt: new Date().toISOString(),
          reason: "Fictional approved promotion",
        });
        await assert.rejects(
          call("HR", "hr_employee_category_convert", {
            employeeCode: codes.OTHER,
            expectedVersion: requested.record.version,
            action: "APPROVE",
            conversionRef: requested.record.ref,
            reason: "Self approval",
          }),
          (e) => e.status === 403,
        );
        const development = await db((tx) =>
          tx.assessmentIntegration.create({
            data: {
              tenantId: company,
              employeeCode: codes.OTHER,
              kind: "DEVELOPMENT",
              key: codes.OTHER + ":TASK:1:K:CAPABILITY_GAP",
              sourceRef: randomUUID(),
              status: "PROPOSED",
              payload: {
                employeeCode: codes.OTHER,
                managerCode: codes.MANAGER,
              },
            },
          }),
        );
        await completeBusinessApproval(
          prisma,
          company,
          "CATEGORY_CONVERSION",
          requested.record.ref,
        );
        const done = await call("CEO", "hr_employee_category_convert", {
          employeeCode: codes.OTHER,
          expectedVersion: requested.record.version,
          action: "APPROVE",
          conversionRef: requested.record.ref,
          reason: "Independent approval",
        });
        assert.equal(done.record.state, "APPLIED");
        assert.match(done.record.payload.newCode, /^MGMT-/);
        const alias = await db((tx) =>
          tx.employeeCodeAlias.findFirst({
            where: { tenantId: company, employeeCode: codes.OTHER },
          }),
        );
        assert.equal(alias.newCode, done.record.payload.newCode);
        const rekeyed = await db((tx) =>
          tx.assessmentIntegration.findUnique({
            where: { id: development.id },
          }),
        );
        assert.equal(
          rekeyed.key,
          done.record.payload.newCode + ":TASK:1:K:CAPABILITY_GAP",
        );
        assert.equal(rekeyed.payload.employeeCode, done.record.payload.newCode);

        await assert.rejects(
          db((tx) =>
            tx.employeeCodeReservation.deleteMany({
              where: { tenantId: company, employeeCode: codes.OTHER },
            }),
          ),
          /immutable/,
        );
      },
    );
    const reviewCase = async (
      key,
      type = "RESIGNATION",
      manager = "MANAGER",
    ) => {
      const row = await db(async (tx) =>
        tx.employee.create({
          data: await prepareEmployeeInsert(
            tx,
            {
              first_name: "Fictional",
              last_name: key,
              status: "Active",
              managerId: people[manager].id,
              gradeLevelId: people.LEAVER.gradeLevelId,
              userId: 100000 + Math.floor(Math.random() * 1e8),
            },
            { tenantId: company, category: "EMPLOYEE" },
          ),
        }),
      );
      people[key] = row;
      codes[key] = row.employee_code;
      const s = (
        await call(key, "hr_separation_create", {
          employeeCode: row.employee_code,
          expectedVersion: 0,
          type,
          proposedLastWorkingAt: new Date(
            Date.now() + 86400000 * 10,
          ).toISOString(),
          reasonCode: "OTHER",
          reason: "Fictional workflow review",
        })
      ).record;
      await command(key, "hr_separation_action", s, {
        action: "SUBMIT",
        reason: "Submit",
      });
      const recommend = () =>
        command(manager, "hr_separation_manager_recommend", s, {
          recommendation: "ACCEPT",
          reason: "Reviewed",
          replacementCode: codes.RECEIVER,
          interimOwnerCode: codes.RECEIVER,
          topics: ["Application"],
          deliverables: [],
        });
      const finding = {
        status: "VERIFIED",
        finding: "Fictional verification",
        evidenceRefs: ["fictional-evidence:01"],
      };
      const verify = () =>
        command("HR", "hr_separation_hr_verify", s, {
          findings: Object.fromEntries(
            ["notice", "leave", "loans", "bonds", "discipline", "assets"].map(
              (k) => [k, finding],
            ),
          ),
        });
      await recommend();
      await verify();
      return { s, recommend, verify };
    };
    await t.test(
      "deferral returns automatically to the manager and withdrawal is personal",
      async () => {
        const { s } = await reviewCase("DEFER");
        const date = new Date(Date.now() + 86400000 * 2)
          .toISOString()
          .slice(0, 10);
        await command("CEO", "hr_separation_decide", s, {
          decision: "DEFER",
          reason: "Fictional review date",
          deferredUntil: date,
        });
        await assert.rejects(
          command("CEO", "hr_separation_decide", s, {
            decision: "APPROVE",
            reason: "Premature",
          }),
          (e) => e.status === 409,
        );
        const now = new Date(Date.now() + 86400000 * 3);
        await db((tx) =>
          sweepCompany(tx, { tenantId: company, now, who: null }),
        );
        assert.equal(
          (await db((tx) => tx.separation.findUnique({ where: { id: s.ref } })))
            .state,
          "MANAGER_REVIEW",
        );
        await assert.rejects(
          command("MANAGER", "hr_separation_action", s, {
            action: "WITHDRAW",
            reason: "Not the employee",
          }),
          (e) => e.status === 403,
        );
        const withdrawn = await command("DEFER", "hr_separation_action", s, {
          action: "WITHDRAW",
          reason: "Personal withdrawal",
        });
        assert.equal(withdrawn.record.state, "WITHDRAWN");
      },
    );
    await t.test(
      "approved early release and garden leave require independent decisions; withdrawal after approval needs management",
      async () => {
        const { s } = await reviewCase("NOTICE");
        await command("CEO", "hr_separation_decide", s, {
          decision: "APPROVE",
          reason: "Approve",
        });
        let n = (await taskRows(s, "noticePeriodRecord"))[0];
        await command("NOTICE", "hr_separation_notice", s, {
          action: "REQUEST_EARLY_RELEASE",
          reason: "Fictional request",
          lastWorkingAt: new Date(Date.now() + 86400000 * 4).toISOString(),
          noticeVersion: n.version,
        });
        n = (await taskRows(s, "noticePeriodRecord"))[0];
        await completeBusinessApproval(
          prisma,
          company,
          "NOTICE_CHANGE",
          `${n.id}@${n.version}`,
        );
        await command("CEO", "hr_separation_notice", s, {
          action: "APPROVE",
          reason: "Independent early release",
          noticeVersion: n.version,
        });
        n = (await taskRows(s, "noticePeriodRecord"))[0];
        await command("NOTICE", "hr_separation_notice", s, {
          action: "REQUEST_GARDEN_LEAVE",
          reason: "Fictional garden leave",
          noticeVersion: n.version,
        });
        n = (await taskRows(s, "noticePeriodRecord"))[0];
        await completeBusinessApproval(
          prisma,
          company,
          "NOTICE_CHANGE",
          `${n.id}@${n.version}`,
        );
        await command("CEO", "hr_separation_notice", s, {
          action: "APPROVE",
          reason: "Independent garden leave",
          noticeVersion: n.version,
        });
        assert.equal(
          (await taskRows(s, "noticePeriodRecord"))[0].payload.gardenLeave,
          true,
        );
        const pending = await command("NOTICE", "hr_separation_action", s, {
          action: "WITHDRAW",
          reason: "Request withdrawal",
        });
        assert.equal(pending.record.state, "NOTICE_PERIOD");
        const withdrawal = await db((tx) =>
          tx.separation.findUnique({ where: { id: s.ref } }),
        );
        await completeBusinessApproval(
          prisma,
          company,
          "SEPARATION_WITHDRAWAL",
          `${s.ref}@${new Date(withdrawal.withdrawalRequestedAt).getTime()}`,
        );
        const done = await command("CEO", "hr_separation_decide", s, {
          decision: "APPROVE_WITHDRAWAL",
          reason: "Independent approval",
        });
        assert.equal(done.record.state, "WITHDRAWN");
      },
    );
    await t.test(
      "Management reverts to HR; HR and manager revert to the initiator with fresh reviews on resubmission",
      async () => {
        const { s, recommend, verify } = await reviewCase("REVERT");
        let returned = await command("CEO", "hr_separation_revert", s, {
          reason: "Clarify the HR findings",
        });
        assert.equal(returned.record.state, "HR_VERIFICATION");
        const history = await as("CEO", () =>
          h.hr_separation_list({
            employeeCode: codes.REVERT,
            separationRef: s.ref,
            view: "APPROVER",
          }),
        );
        assert.ok(
          history.items.some(
            (i) =>
              i.kind === "HISTORY" && i.payload.review?.verification?.notice,
          ),
        );
        const ownHistory = await as(
          "REVERT",
          () =>
            h.hr_separation_list({
              employeeCode: codes.REVERT,
              separationRef: s.ref,
              view: "SELF",
            }),
          ["hr.separation.self"],
        );
        assert.ok(
          ownHistory.items.every(
            (i) => i.kind !== "HISTORY" || !i.payload.review?.verification,
          ),
        );

        await verify();
        returned = await command("CEO", "hr_separation_revert", s, {
          reason: "Further HR clarification",
        });
        returned = await command("HR", "hr_separation_revert", s, {
          reason: "Initiator evidence needs correction",
        });
        assert.equal(returned.record.state, "DRAFT");
        await assert.rejects(
          command("HR", "hr_separation_edit", s, {
            proposedLastWorkingAt: new Date(
              Date.now() + 86400000 * 12,
            ).toISOString(),
            reasonCode: "OTHER",
            reason: "HR cannot impersonate the initiator",
            documents: [],
          }),
          (e) => e.status === 403,
        );
        await command("REVERT", "hr_separation_edit", s, {
          proposedLastWorkingAt: new Date(
            Date.now() + 86400000 * 12,
          ).toISOString(),
          reasonCode: "OTHER",
          reason: "Initiator corrected evidence",
          documents: [],
        });
        await command("REVERT", "hr_separation_action", s, {
          action: "SUBMIT",
          reason: "Resubmit corrected request",
        });
        returned = await command("MANAGER", "hr_separation_revert", s, {
          reason: "Clarify the proposed date",
        });
        assert.equal(returned.record.state, "DRAFT");
        await command("REVERT", "hr_separation_action", s, {
          action: "SUBMIT",
          reason: "Date clarified",
        });
        await recommend();
        await verify();
        const ended = await command("CEO", "hr_separation_decide", s, {
          decision: "REJECT",
          reason: "Management decision after review",
        });
        assert.equal(ended.record.state, "CANCELLED");
        const audits = await db((tx) =>
          tx.separationTransition.findMany({
            where: { tenantId: company, separationRef: s.ref },
          }),
        );
        assert.equal(
          audits.filter((a) => a.payload.action === "REVERTED").length,
          4,
        );
      },
    );
    await t.test(
      "historical self-service cases remain readable through an employee-code alias",
      async () => {
        const { s } = await reviewCase("HISTORY");
        await command("HR", "hr_separation_action", s, {
          action: "CANCEL",
          reason: "Fictional closed history",
        });
        const original = codes.HISTORY,
          person = await db((tx) =>
            tx.employee.findUnique({ where: { id: people.HISTORY.id } }),
          );
        const requested = await call("HR", "hr_employee_category_convert", {
          employeeCode: original,
          expectedVersion: person.version,
          action: "REQUEST",
          category: "MANAGEMENT",
          effectiveAt: new Date().toISOString(),
          reason: "Fictional approved promotion",
        });
        await completeBusinessApproval(
          prisma,
          company,
          "CATEGORY_CONVERSION",
          requested.record.ref,
        );
        const converted = await call("CEO", "hr_employee_category_convert", {
          employeeCode: original,
          expectedVersion: requested.record.version,
          action: "APPROVE",
          conversionRef: requested.record.ref,
          reason: "Independent authorization",
        });
        const newCode = converted.record.payload.newCode;
        const self = await as(
          "HISTORY",
          () => h.hr_separation_list({ employeeCode: newCode, view: "SELF" }),
          ["hr.separation.self"],
        );
        assert.ok(
          self.items.some(
            (row) => row.ref === s.ref && row.employeeCode === original,
          ),
        );
        const detail = await as(
          "HISTORY",
          () =>
            h.hr_separation_list({
              employeeCode: newCode,
              separationRef: s.ref,
              view: "SELF",
            }),
          ["hr.separation.self"],
        );
        assert.equal(detail.record.ref, s.ref);
        assert.equal(detail.record.payload.isInitiator, true);
        const admin = await as("HR", () =>
          h.hr_separation_list({ employeeCode: newCode, view: "HR" }),
        );
        assert.ok(admin.items.some((row) => row.ref === s.ref));
      },
    );
    await t.test(
      "a configured approver remains authorized after an approved code conversion",
      async () => {
        const e = await db((tx) =>
          tx.employee.findUnique({ where: { id: people.CEO.id } }),
        );
        const requested = await call("HR", "hr_employee_category_convert", {
          employeeCode: e.employee_code,
          expectedVersion: e.version,
          action: "REQUEST",
          category: "EMPLOYEE",
          effectiveAt: new Date().toISOString(),
          reason: "Fictional category correction",
        });
        await completeBusinessApproval(
          prisma,
          company,
          "CATEGORY_CONVERSION",
          requested.record.ref,
        );
        const done = await call("MANAGER", "hr_employee_category_convert", {
          employeeCode: e.employee_code,
          expectedVersion: requested.record.version,
          action: "APPROVE",
          conversionRef: requested.record.ref,
          reason: "Independent HR officer approval",
        });
        assert.equal(done.record.state, "APPLIED");
        const { s } = await reviewCase("ALIAS");
        const queue = await as("CEO", () =>
          h.hr_separation_list({ view: "APPROVER" }),
        );
        assert.ok(queue.items.some((x) => x.ref === s.ref));
        await command("CEO", "hr_separation_decide", s, {
          decision: "APPROVE",
          reason: "Authority follows audited alias",
        });
        await db((tx) =>
          tx.separation.update({
            where: { id: s.ref },
            data: { lastWorkingAt: new Date(Date.now() - 1000) },
          }),
        );
        await db((tx) =>
          sweepCompany(tx, { tenantId: company, now: new Date(), who: null }),
        );
        await db((tx) =>
          sweepCompany(tx, { tenantId: company, now: new Date(), who: null }),
        );
        assert.equal(
          await db((tx) =>
            tx.outboxEvent.count({
              where: {
                tenantId: company,
                aggregateId: s.ref,
                eventName: "hr.separation.access_due.v1",
              },
            }),
          ),
          1,
        );
        await command("HR", "hr_separation_action", s, {
          action: "CANCEL",
          reason: "Fictional test completed",
        });
      },
    );
    for (const type of ["RESIGNATION", "TERMINATION_WITH_CAUSE"])
      await t.test(
        `complete ${type} with evidence, outbox and replay`,
        async () => {
          // A second fictional employee keeps the resignation's completed history intact.
          let target = codes.LEAVER;
          if (type !== "RESIGNATION") {
            const row = await db(async (tx) =>
              tx.employee.create({
                data: await prepareEmployeeInsert(
                  tx,
                  {
                    first_name: "Fictional",
                    last_name: "Termination",
                    status: "Active",
                    managerId: people.MANAGER.id,
                    gradeLevelId: people.LEAVER.gradeLevelId,
                    userId: 100000 + Math.floor(Math.random() * 1e8),
                  },
                  { tenantId: company, category: "EMPLOYEE" },
                ),
              }),
            );
            people.TERM = row;
            codes.TERM = row.employee_code;
            target = row.employee_code;
          }
          const subject = type === "RESIGNATION" ? "LEAVER" : "TERM";
          const input = {
            employeeCode: target,
            expectedVersion: 0,
            type,
            proposedLastWorkingAt: new Date(
              Date.now() + 86400000,
            ).toISOString(),
            reasonCode: "OTHER",
            reason: "Fictional scenario",
            documents: [],
            requestKey: randomUUID(),
          };
          const created = await call(
              type === "RESIGNATION" ? subject : "HR",
              "hr_separation_create",
              input,
            ),
            s = created.record;
          const replay = await call(
            type === "RESIGNATION" ? subject : "HR",
            "hr_separation_create",
            input,
          );
          assert.equal(replay.record.ref, s.ref);
          await assert.rejects(
            call(
              "RECEIVER",
              "hr_separation_action",
              {
                employeeCode: target,
                separationRef: s.ref,
                expectedVersion: s.version,
                action: "CANCEL",
                reason: "Unauthorized",
              },
              ["hr.separation.self"],
            ),
            (e) => e.status === 404 || e.status === 403,
          );
          await command(
            type === "RESIGNATION" ? subject : "HR",
            "hr_separation_action",
            s,
            { action: "SUBMIT", reason: "Submit" },
          );
          await assert.rejects(
            call("HR", "hr_separation_action", {
              employeeCode: target,
              separationRef: s.ref,
              expectedVersion: 1,
              action: "CANCEL",
              reason: "Stale",
            }),
            (e) => e.status === 409,
          );
          await command("MANAGER", "hr_separation_manager_recommend", s, {
            recommendation: "ACCEPT",
            reason: "Reviewed",
            replacementCode: codes.RECEIVER,
            interimOwnerCode: codes.RECEIVER,
            topics: ["Fictional system"],
            deliverables: ["Fictional project"],
          });
          const finding = {
            status: "VERIFIED",
            finding: "Fictional verification",
            evidenceRefs: ["fictional-evidence:01"],
          };
          await command("HR", "hr_separation_hr_verify", s, {
            findings: Object.fromEntries(
              ["notice", "leave", "loans", "bonds", "discipline", "assets"].map(
                (k) => [k, finding],
              ),
            ),
          });
          await assert.rejects(
            command("MANAGER", "hr_separation_decide", s, {
              decision: "APPROVE",
              reason: "Wrong authority",
            }),
            (e) => e.status === 403,
          );
          await command("CEO", "hr_separation_decide", s, {
            decision: "APPROVE",
            reason: "Independent approval",
          });
          if (type === "RESIGNATION") {
            let n = (await taskRows(s, "noticePeriodRecord"))[0];
            await command(subject, "hr_separation_notice", s, {
              action: "REQUEST_BUYOUT",
              reason: "Fictional buyout",
              days: 1,
              noticeVersion: n.version,
            });
            n = (await taskRows(s, "noticePeriodRecord"))[0];
            await completeBusinessApproval(
              prisma,
              company,
              "NOTICE_CHANGE",
              `${n.id}@${n.version}`,
            );
            await command("CEO", "hr_separation_notice", s, {
              action: "APPROVE",
              reason: "Approve buyout",
              noticeVersion: n.version,
            });
          }
          for (const source of ["ASSETS", "PAYROLL", "INCENTIVES"])
            await command("HR", "hr_separation_source_sync", s, {
              source,
              sourceRef: "fictional-source:" + source,
              sourceVersion: 1,
              asOf: new Date().toISOString(),
              evidenceRefs: ["fictional-evidence:01"],
              ...(source === "ASSETS"
                ? {
                    assets: [
                      {
                        assetRef: "LAPTOP-1",
                        serial: "FICTIONAL-001",
                        condition: "Good",
                      },
                    ],
                  }
                : source === "PAYROLL"
                  ? {
                      financial: {
                        dailyRateMinor: 10000,
                        leaveDays: 1,
                        loansMinor: 0,
                        advancesMinor: 0,
                        bondsMinor: 0,
                        incentiveClawbacksMinor: 0,
                      },
                    }
                  : { incentiveClawbacksMinor: 0 }),
            });
          await command("HR", "hr_separation_action", s, {
            action: "START_HANDOVER",
            reason: "Start handover",
          });
          await assert.rejects(
            command("HR", "hr_separation_action", s, {
              action: "START_CLEARANCE",
              reason: "Too early",
            }),
            (e) => e.status === 409,
          );
          let sessions = await taskRows(s, "replacementSession");
          for (let row of sessions) {
            await taskCommand(
              "RECEIVER",
              "hr_separation_replacement",
              s,
              "replacementSession",
              row,
              { action: "COMPLETE_SESSION" },
            );
            row = (await taskRows(s, "replacementSession")).find(
              (x) => x.id === row.id,
            );
            await taskCommand(
              "RECEIVER",
              "hr_separation_replacement",
              s,
              "replacementSession",
              row,
              { action: "ACKNOWLEDGE_SESSION" },
            );
          }
          await taskCommand(
            "MANAGER",
            "hr_separation_replacement",
            s,
            "replacementPlan",
            (await taskRows(s, "replacementPlan"))[0],
            { action: "READINESS" },
          );
          for (let row of await taskRows(s, "knowledgeTransferItem")) {
            await taskCommand(
              subject,
              "hr_separation_kt",
              s,
              "knowledgeTransferItem",
              row,
              { action: "COMPLETE" },
            );
            row = (await taskRows(s, "knowledgeTransferItem")).find(
              (x) => x.id === row.id,
            );
            await taskCommand(
              subject,
              "hr_separation_kt",
              s,
              "knowledgeTransferItem",
              row,
              { action: "ACK_LEAVER" },
            );
            row = (await taskRows(s, "knowledgeTransferItem")).find(
              (x) => x.id === row.id,
            );
            await taskCommand(
              "RECEIVER",
              "hr_separation_kt",
              s,
              "knowledgeTransferItem",
              row,
              { action: "ACK_RECEIVER" },
            );
          }
          await taskCommand(
            "HR",
            "hr_separation_asset",
            s,
            "assetHandoverItem",
            (await taskRows(s, "assetHandoverItem"))[0],
            {
              disposition: "RETURNED",
              condition: "Good",
              serialVerified: true,
            },
          );
          await command("HR", "hr_separation_action", s, {
            action: "START_CLEARANCE",
            reason: "Handover complete",
          });
          for (const row of await taskRows(s, "clearanceItem"))
            await taskCommand(
              row.key === "HR" ? "HR" : "RECEIVER",
              "hr_separation_clearance",
              s,
              "clearanceItem",
              row,
              {
                departmentCode: row.key,
                noDues: true,
                dues: [],
                reason: "No dues",
              },
            );
          let interview = (await taskRows(s, "exitInterview"))[0];
          await command("HR", "hr_separation_interview", s, {
            taskVersion: interview.version,
            reasonTaxonomy: "OTHER",
            responses: [
              { questionCode: "REASON", answer: "Fictional response" },
            ],
            notes: "Fictional HR private note",
            evidenceRefs: ["fictional-evidence:02"],
          });
          const own = await as(
            subject,
            () =>
              h.hr_separation_list({
                employeeCode: target,
                separationRef: s.ref,
                view: "SELF",
              }),
            ["hr.separation.self"],
          );
          assert.ok(!own.items.some((x) => x.kind === "INTERVIEW"));
          let sheet = (await taskRows(s, "finalSettlementSheet"))[0];
          await command("HR", "hr_separation_settlement", s, {
            taskVersion: sheet.version,
            action: "PREPARE",
            sourceVersion: 1,
          });
          sheet = (await taskRows(s, "finalSettlementSheet"))[0];
          await command("HR", "hr_separation_source_sync", s, {
            source: "INCENTIVES",
            sourceRef: "fictional-source:INCENTIVES",
            sourceVersion: 2,
            asOf: new Date().toISOString(),
            evidenceRefs: ["fictional-evidence:02"],
            incentiveClawbacksMinor: 100,
          });
          await assert.rejects(
            command("HR", "hr_separation_settlement", s, {
              taskVersion: sheet.version,
              action: "HANDOFF",
              sourceVersion: 1,
            }),
            (e) => e.status === 409,
          );
          await command("HR", "hr_separation_settlement", s, {
            taskVersion: sheet.version,
            action: "PREPARE",
            sourceVersion: 1,
          });
          sheet = (await taskRows(s, "finalSettlementSheet"))[0];
          await completeBusinessApproval(
            prisma,
            company,
            "SETTLEMENT",
            `${sheet.id}@${sheet.version}`,
          );
          await command("HR", "hr_separation_settlement", s, {
            taskVersion: sheet.version,
            action: "HANDOFF",
            sourceVersion: 1,
          });
          sheet = (await taskRows(s, "finalSettlementSheet"))[0];
          const handoff = await db((tx) =>
            tx.employmentDelivery.findFirst({
              where: {
                tenantId: company,
                kind: "PAYROLL_HANDOFF",
                payload: { path: ["separationRef"], equals: s.ref },
              },
            }),
          );
          if (type === "RESIGNATION") {
            await command("HR", "hr_separation_settlement", s, {
              taskVersion: sheet.version,
              action: "PAYROLL_ACK",
              sourceVersion: 1,
              receiptRef: "fictional-payroll-receipt",
            });
            await as("HR", () =>
              processDelivery(company, handoff.id, {
                deliver: async () => {
                  assert.fail("Manual receipt already completed this delivery");
                },
              }),
            );
          } else {
            let attempts = 0;
            const deliver = async () => {
              if (++attempts === 1)
                throw new Error("Fictional temporary outage");
              return { receiptRef: "fictional-payroll-receipt" };
            };
            await as("HR", () =>
              processDelivery(company, handoff.id, { deliver }),
            );
            assert.equal(
              (
                await db((tx) =>
                  tx.employmentDelivery.findUnique({
                    where: { id: handoff.id },
                  }),
                )
              ).state,
              "RETRY",
            );
            const retryAt = new Date(Date.now() + 60000);
            await as("HR", () =>
              processDelivery(company, handoff.id, { deliver, now: retryAt }),
            );
            await as("HR", () =>
              processDelivery(company, handoff.id, { deliver, now: retryAt }),
            );
            assert.equal(attempts, 2);
            assert.equal(
              await db((tx) =>
                tx.separationTransition.count({
                  where: {
                    tenantId: company,
                    separationRef: s.ref,
                    payload: {
                      path: ["action"],
                      equals: "PAYROLL_ACKNOWLEDGED",
                    },
                  },
                }),
              ),
              1,
            );
          }
          assert.equal(
            (
              await db((tx) =>
                tx.employmentDelivery.findUnique({ where: { id: handoff.id } }),
              )
            ).state,
            "DELIVERED",
          );
          await assert.rejects(
            command("HR", "hr_separation_action", s, {
              action: "COMPLETE_EXIT",
              reason: "Not yet",
              rehireEligible: true,
            }),
            (e) => e.status === 409,
          );
          // Simulate elapsed notice in this isolated fixture.
          await db((tx) =>
            tx.separation.update({
              where: { id: s.ref },
              data: { lastWorkingAt: new Date(Date.now() - 1000) },
            }),
          );
          for (const row of await taskRows(s, "accessRevocationTask"))
            await taskCommand(
              "RECEIVER",
              "hr_separation_access",
              s,
              "accessRevocationTask",
              row,
              {
                system: row.key,
                confirmationRef: "fictional-revocation:" + row.key,
              },
            );
          const done = await command("HR", "hr_separation_action", s, {
            action: "COMPLETE_EXIT",
            reason: "All gates verified",
            rehireEligible: true,
          });
          assert.equal(done.record.state, "EXIT_COMPLETED");
          const events = await db((tx) =>
            tx.outboxEvent.findMany({
              where: { tenantId: company, aggregateId: s.ref },
            }),
          );
          assert.ok(
            events.some((e) => e.eventName === "hr.employee.separated.v1"),
          );
          assert.ok(
            events.some(
              (e) => e.eventName === "hr.separation.settlement_ready.v1",
            ),
          );
          assert.ok(
            events.every(
              (e) =>
                !JSON.stringify(e.payload).includes(
                  "Fictional HR private note",
                ),
            ),
          );
          const hidden = await mcpCtx.run({ user: { tenantId: other } }, () =>
            tenantTransaction(prisma, (tx) => tx.separation.findMany({}), {
              tenantId: other,
            }),
          );
          assert.equal(hidden.length, 0);
        },
      );
  },
);
test.after(async () => {
  await prisma.$disconnect();
});
