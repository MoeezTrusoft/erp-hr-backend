// TS-REQUEST-HYBRID-01 (operator, 2026-10-27) — the hybrid anomaly-resolution
// lifecycle, end to end against PostgreSQL:
//
//   detected case (Not Submitted)
//     → the EMPLOYEE raises it, or HR raises it ON THEIR BEHALF (reason only)
//     → HR verification (the Level-1 manager stage is paused)
//     → Management decides
//     → APPROVED resolves with no payroll deduction, REJECTED deducts.
//
// The payroll half is asserted through `ruleDeductions`, the exact pricing
// helper reconcileRulePayroll feeds: only a REJECTED case that Management
// decided is priced, so an approved — or still-pending — case can never deduct.
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
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const { prisma, company, people, db, setup } = await import("./fixtures.mjs");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { applyEvaluatedShifts } = await import(
  "../../src/services/attendanceWriter.service.js"
);
const { raiseRuleRequest, raiseRuleRequestOnBehalf } = await import(
  "../../src/services/attendanceRules.service.js"
);
const { actApproval } = await import("../../src/services/approval/service.js");
const { ruleDeductions } = await import("../../src/lib/attendanceAnomalyRules.js");
const { isStagePaused } = await import("../../src/lib/approvalStagePolicy.js");

// The approval centre and the attendance services both read the verified
// context, so the acting employee (id, roles) has to be on it exactly as the
// MCP layer puts it there.
const ROLE_NAMES = { HR: ["hr"], MANAGEMENT: ["management"] };
const GRANTS = {
  EMPLOYEE: ["self"],
  HR: ["self", "verify", "read"],
  MANAGEMENT: ["self", "approve", "read"],
};
const as = (role, fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: company,
        userId: people[role].userId,
        employeeId: people[role].id,
        roles: ROLE_NAMES[role] ?? [],
        isAdmin: false,
      },
      permissions: GRANTS[role].map((k) => "hr.approvals." + k),
    },
    fn,
  );

const act = (role, record, action, reason) =>
  as(role, () =>
    actApproval({
      approvalRef: record.approvalRef,
      expectedVersion: record.version,
      action,
      reason: reason ?? `${role} ${action}: evidence reviewed`,
      requestKey: randomUUID(),
    }),
  ).then((r) => r.record);

const readCase = (id) => db((tx) => tx.attendanceAnomaly.findUnique({ where: { id } }));
const readRequest = (ref) =>
  db((tx) =>
    tx.hrApprovalRequest.findUnique({
      where: { tenantId_kind_sourceRef: { tenantId: company, kind: "ATTENDANCE", sourceRef: ref } },
    }),
  );

// A day that the evaluator grades as LATE_CHECKIN, i.e. a DETECTED case with no
// request against it yet — the state the operator describes as "shows in the
// attendance table … and Request status Not Submitted".
let dayOffset = 20;
async function detectedCase() {
  const date = new Date(Date.UTC(2026, 9, dayOffset++));
  let anomaly;
  await db(async (tx) => {
    for (const [hour, minute, status] of [
      [9, 45, 0],
      [17, 0, 1],
    ])
      await tx.attendanceDevicePunch.create({
        data: {
          tenantId: company,
          employeeId: people.EMPLOYEE.id,
          sn: "TEST-DEVICE",
          siteId: "HO",
          deviceUserId: "101",
          punchedAt: new Date(+date + (hour * 60 + minute) * 60000),
          status,
          directionVerified: true,
        },
      });
    const day = date.toISOString().slice(0, 10);
    await applyEvaluatedShifts({
      tenantId: company,
      from: day,
      to: day,
      employeeIds: [people.EMPLOYEE.id],
      db: tx,
      dryRun: false,
      now: new Date(+date + 3 * 86400000),
    });
    anomaly = await tx.attendanceAnomaly.findFirst({
      where: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        date,
        type: "LATE_CHECKIN",
        status: "PENDING",
      },
    });
  });
  assert.ok(anomaly, "the evaluator detected a late case");
  assert.equal(anomaly.rulesVersion, 2);
  assert.equal(anomaly.sourceKind, "RULES_V2");
  assert.equal(anomaly.evidenceState, "ACTIVE");
  return anomaly;
}

const raiseRef = (anomaly) => `${anomaly.id}@${anomaly.factHash}`;

test(
  "detected case → employee or HR raises the resolution request → HR verifies → Management decides",
  { timeout: 180000 },
  async (t) => {
    await setup();

    await t.test("a detected case carries no request and prices no deduction", async () => {
      const anomaly = await detectedCase();
      assert.equal(anomaly.reason, null, "nothing has been explained yet");
      assert.equal(anomaly.raisedById, null, "and nobody has raised it");
      assert.equal(await readRequest(raiseRef(anomaly)), null);
      assert.equal(
        ruleDeductions([anomaly], {
          from: anomaly.date,
          to: anomaly.date,
        }).days,
        0,
        "an unanswered case must not deduct",
      );
    });

    await t.test("the timesheet row reads Not Submitted, then the live stage", async () => {
      const { listCheckInOuts } = await import(
        "../../src/services/timesheetReport.service.js"
      );
      const anomaly = await detectedCase();
      const day = anomaly.date.toISOString().slice(0, 10);
      // The read screen runs under the REST/MCP context (deny-by-default RLS).
      const rowFor = async () => {
        const page = await mcpCtx.run({ system: true }, () =>
          listCheckInOuts({
            tenantId: company,
            from: day,
            to: day,
            employeeId: people.EMPLOYEE.id,
            page: 1,
            pageSize: 50,
          }),
        );
        return page.items.find(
          (row) => new Date(row.date).toISOString().slice(0, 10) === day,
        );
      };
      const before = await rowFor();
      assert.ok(before, "the day is on the timesheet");
      assert.equal(
        before.request?.status,
        "UNSUBMITTED",
        "a detected case with no request reads Not Submitted",
      );
      assert.equal(before.request.stage ?? null, null);
      assert.equal(
        before.request.anomalyId,
        anomaly.id,
        "the row carries the case the raise addresses",
      );
      assert.equal(before.request.type, "LATE_CHECKIN");
      const record = await as("HR", () =>
        raiseRuleRequestOnBehalf({
          user: {
            tenantId: company,
            userId: people.HR.userId,
            employeeId: people.HR.id,
            roles: ["hr"],
          },
          anomalyId: anomaly.id,
          reason: "Filed from the gate register while the employee was on site",
          requestKey: randomUUID(),
        }),
      );
      const after = await rowFor();
      assert.equal(after.request.status, "PENDING");
      assert.equal(
        after.request.stage,
        "MANAGEMENT",
        "HR raised it, so it is already HR-verified and Management decides next",
      );
      assert.equal(String(after.request.approvalRef), String(record.approvalRef));
      assert.equal(after.request.raisedById, people.HR.id, "and it says who filed it");
      assert.equal(after.request.type, "LATE_CHECKIN");
    });

    await t.test("the employee raises their own case and it lands at HR, not the paused manager stage", async () => {
      assert.equal(
        isStagePaused("ATTENDANCE", "LINE_MANAGER"),
        true,
        "precondition: the manager stage is paused for attendance",
      );
      const anomaly = await detectedCase();
      const record = await as("EMPLOYEE", () =>
        raiseRuleRequest({
          user: {
            tenantId: company,
            userId: people.EMPLOYEE.userId,
            employeeId: people.EMPLOYEE.id,
          },
          anomalyId: anomaly.id,
          reason: "The reader was queueing and my entry punched at 09:45",
          requestKey: randomUUID(),
        }),
      );
      assert.equal(record.kind, "ATTENDANCE");
      assert.equal(record.sourceRef, raiseRef(anomaly));
      assert.equal(record.employeeCode, people.EMPLOYEE.employee_code);
      assert.equal(record.stage, "HR", "the paused manager stage is skipped");
      assert.ok(record.approvalRef, "the raise opened a request in the centre");
      // The submission's own audit row records the jump, so the skip is
      // visible in the trail rather than implied.
      assert.equal(record.history[0].fromStage, "INITIATOR");
      assert.equal(record.history[0].toStage, "HR");
      const stored = await readCase(anomaly.id);
      assert.equal(stored.reason, "The reader was queueing and my entry punched at 09:45");
      assert.equal(stored.raisedById, people.EMPLOYEE.id, "self-filed");
      assert.equal(stored.raisedByName, null);
      assert.ok(
        stored.workflowVersion > anomaly.workflowVersion,
        "completing the case advances its version",
      );
      assert.equal(
        ruleDeductions([stored], { from: stored.date, to: stored.date }).days,
        0,
        "a request in flight must not deduct",
      );
    });

    await t.test("HR raises on behalf — the employee owns the request, HR is the filer", async () => {
      const anomaly = await detectedCase();
      const record = await as("HR", () =>
        raiseRuleRequestOnBehalf({
          user: {
            tenantId: company,
            userId: people.HR.userId,
            employeeId: people.HR.id,
            roles: ["hr"],
          },
          anomalyId: anomaly.id,
          reason: "Employee was on a site visit; attendance verified from the register",
          requestKey: randomUUID(),
        }),
      );
      assert.equal(record.stage, "MANAGEMENT", "HR-verified by the act of raising");
      assert.equal(
        record.employeeCode,
        people.EMPLOYEE.employee_code,
        "the request belongs to the subject employee",
      );
      // The trail keeps both steps: submission into HR, then HR's own verification.
      assert.deepEqual(
        record.history.slice(0, 2).map((h) => [h.action, h.fromStage, h.toStage]),
        [
          ["SUBMIT", "INITIATOR", "HR"],
          ["VERIFY", "HR", "MANAGEMENT"],
        ],
      );
      assert.equal(record.history[1].actorCode, people.HR.employee_code);
      const stored = await readCase(anomaly.id);
      assert.equal(stored.raisedById, people.HR.id, "filed by HR, not the employee");
      assert.ok(stored.raisedByName, "the filer name is snapshotted on the case");
      // The op that filed it is on the attendance trail too.
      const trail = await db((tx) =>
        tx.attendanceRuleAudit.findFirst({
          where: { tenantId: company, anomalyId: anomaly.id, action: "REQUEST_RAISED_ON_BEHALF" },
        }),
      );
      assert.ok(trail, "the on-behalf raise is audited as such");
      assert.equal(trail.actorId, String(people.HR.userId));
    });

    await t.test("a raise with no reason, or a second raise of a live request, is refused", async () => {
      const anomaly = await detectedCase();
      const user = {
        tenantId: company,
        userId: people.EMPLOYEE.userId,
        employeeId: people.EMPLOYEE.id,
      };
      await assert.rejects(
        as("EMPLOYEE", () =>
          raiseRuleRequest({ user, anomalyId: anomaly.id, reason: "   " }),
        ),
        (e) => e.status === 400,
      );
      assert.equal((await readCase(anomaly.id)).reason, null, "nothing was stamped");
      await as("EMPLOYEE", () =>
        raiseRuleRequest({
          user,
          anomalyId: anomaly.id,
          reason: "Forgot to check out; the gate log shows 17:00",
          requestKey: randomUUID(),
        }),
      );
      await assert.rejects(
        as("EMPLOYEE", () =>
          raiseRuleRequest({
            user,
            anomalyId: anomaly.id,
            reason: "Second attempt at the same day",
            requestKey: randomUUID(),
          }),
        ),
        (e) => e.status === 409 || e.status === 403,
        "one live request per case",
      );
    });

    await t.test("Management approval resolves the case and deducts nothing", async () => {
      const anomaly = await detectedCase();
      const record = await as("EMPLOYEE", () =>
        raiseRuleRequest({
          user: {
            tenantId: company,
            userId: people.EMPLOYEE.userId,
            employeeId: people.EMPLOYEE.id,
          },
          anomalyId: anomaly.id,
          reason: "Reader failure; the site register confirms the times",
          requestKey: randomUUID(),
        }),
      );
      let row = await act("HR", record, "VERIFY");
      assert.equal(row.stage, "MANAGEMENT");
      row = await act("MANAGEMENT", row, "APPROVE");
      assert.equal(row.stage, "APPROVED");
      const decided = await readCase(anomaly.id);
      assert.equal(decided.status, "APPROVED");
      assert.equal(decided.decisionRole, "Management");
      assert.equal(
        ruleDeductions([decided], { from: decided.date, to: decided.date }).days,
        0,
        "approved means no deduction",
      );
    });

    await t.test("a rejection is priced — declined means the deduction falls", async () => {
      const anomaly = await detectedCase();
      const record = await as("HR", () =>
        raiseRuleRequestOnBehalf({
          user: {
            tenantId: company,
            userId: people.HR.userId,
            employeeId: people.HR.id,
            roles: ["hr"],
          },
          anomalyId: anomaly.id,
          reason: "No supporting evidence was produced for the late arrival",
          requestKey: randomUUID(),
        }),
      );
      assert.equal(record.stage, "MANAGEMENT", "an on-behalf raise needs no second HR step");
      const row = await act("MANAGEMENT", record, "REJECT");
      assert.equal(row.stage, "REJECTED");
      const decided = await readCase(anomaly.id);
      assert.equal(decided.status, "REJECTED");
      assert.equal(decided.decisionRole, "Management");
      const priced = ruleDeductions([decided], { from: decided.date, to: decided.date });
      assert.equal(priced.days, 0.5, "a rejected late arrival is half a day");
      assert.deepEqual(priced.lines[0].anomalyIds, [decided.id]);
    });

    await t.test("the employee's own dialog raises by day, and picks the case when the day has two", async () => {
      const anomaly = await detectedCase();
      const day = anomaly.date.toISOString().slice(0, 10);
      const self = {
        tenantId: company,
        userId: people.EMPLOYEE.userId,
        employeeId: people.EMPLOYEE.id,
      };
      // A second open case on the SAME day: a late check-in and a missing
      // check-out legitimately coexist, and one raise resolves one case.
      const second = await db((tx) =>
        tx.attendanceAnomaly.create({
          data: {
            tenantId: company,
            employeeId: people.EMPLOYEE.id,
            date: anomaly.date,
            type: "MISSING_CHECKOUT",
            rulesVersion: 2,
            sourceKind: "RULES_V2",
            sourceRef: `rules-v2:${people.EMPLOYEE.id}:${anomaly.sessionKey}:MISSING_CHECKOUT`,
            sessionKey: anomaly.sessionKey,
            factHash: "test-fact-hash-missing-checkout",
            status: "PENDING",
            evidenceState: "ACTIVE",
          },
        }),
      );
      await assert.rejects(
        as("EMPLOYEE", () =>
          raiseRuleRequest({
            user: self,
            date: day,
            reason: "Which of my two cases does this resolve?",
            requestKey: randomUUID(),
          }),
        ),
        (e) => e.status === 409 && /open cases/.test(e.message),
      );
      const record = await as("EMPLOYEE", () =>
        raiseRuleRequest({
          user: self,
          date: day,
          type: "MISSING_CHECKOUT",
          reason: "I left through the side gate and did not punch out",
          requestKey: randomUUID(),
        }),
      );
      assert.equal(record.anomalyId, second.id, "the named case was raised");
      assert.equal(
        (await readCase(anomaly.id)).reason,
        null,
        "the other case on the day is untouched",
      );
      assert.equal(
        (await readCase(second.id)).reason,
        "I left through the side gate and did not punch out",
      );
    });

    await t.test("an on-behalf raise by day targets the employee, never the HR caller", async () => {
      const anomaly = await detectedCase();
      const day = anomaly.date.toISOString().slice(0, 10);
      // HR owns no case on this day: resolving the day against the CALLER would
      // find nothing, so a success here proves the subject was used.
      const record = await as("HR", () =>
        raiseRuleRequestOnBehalf({
          user: {
            tenantId: company,
            userId: people.HR.userId,
            employeeId: people.HR.id,
            roles: ["hr"],
          },
          date: day,
          employeeId: people.EMPLOYEE.id,
          reason: "Attendance confirmed from the site register for this date",
          requestKey: randomUUID(),
        }),
      );
      assert.equal(record.anomalyId, anomaly.id);
      assert.equal(record.employeeCode, people.EMPLOYEE.employee_code);
      assert.equal((await readCase(anomaly.id)).raisedById, people.HR.id);
      await assert.rejects(
        as("HR", () =>
          raiseRuleRequestOnBehalf({
            user: {
              tenantId: company,
              userId: people.HR.userId,
              employeeId: people.HR.id,
              roles: ["hr"],
            },
            date: day,
            employeeId: people.MANAGER.id,
            reason: "Wrong employee claimed",
            requestKey: randomUUID(),
          }),
        ),
        (e) => e.status === 404 || e.status === 400,
      );
    });

    await t.test("a decided case cannot be raised again", async () => {
      const anomaly = await detectedCase();
      const record = await as("EMPLOYEE", () =>
        raiseRuleRequest({
          user: {
            tenantId: company,
            userId: people.EMPLOYEE.userId,
            employeeId: people.EMPLOYEE.id,
          },
          anomalyId: anomaly.id,
          reason: "Late because of the 08:40 traffic diversion",
          requestKey: randomUUID(),
        }),
      );
      let row = await act("HR", record, "VERIFY");
      await act("MANAGEMENT", row, "REJECT");
      await assert.rejects(
        as("EMPLOYEE", () =>
          raiseRuleRequest({
            user: {
              tenantId: company,
              userId: people.EMPLOYEE.userId,
              employeeId: people.EMPLOYEE.id,
            },
            anomalyId: anomaly.id,
            reason: "Trying again after the decision",
            requestKey: randomUUID(),
          }),
        ),
        (e) => e.status === 409,
      );
    });

    await t.test("an employee cannot raise a case that is not theirs, nor through the HR door", async () => {
      const anomaly = await detectedCase();
      const record = await as("HR", () =>
        raiseRuleRequestOnBehalf({
          user: {
            tenantId: company,
            userId: people.HR.userId,
            employeeId: people.HR.id,
            roles: ["hr"],
          },
          anomalyId: anomaly.id,
          reason: "Filed by HR under verification duty",
          requestKey: randomUUID(),
        }),
      );
      assert.ok(record.sourceRef.endsWith("@" + (await readCase(anomaly.id)).factHash));
      // A second employee (the MANAGER acts as a non-owner here) cannot raise
      // this case through either door.
      const other = await detectedCase();
      await assert.rejects(
        as("MANAGEMENT", () =>
          raiseRuleRequest({
            user: {
              tenantId: company,
              userId: people.MANAGEMENT.userId,
              employeeId: people.MANAGEMENT.id,
              roles: ["management"],
            },
            anomalyId: other.id,
            reason: "Not mine to raise",
            requestKey: randomUUID(),
          }),
        ),
        (e) => e.status === 403,
      );
      await assert.rejects(
        as("MANAGEMENT", () =>
          raiseRuleRequestOnBehalf({
            user: {
              tenantId: company,
              userId: people.MANAGEMENT.userId,
              employeeId: people.MANAGEMENT.id,
              roles: ["management"],
            },
            anomalyId: other.id,
            reason: "Not my case to file either",
            requestKey: randomUUID(),
          }),
        ),
        (e) => e.status === 403,
      );
    });
  },
);
