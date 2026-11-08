// HR-ATT-APPEAL-01 (operator, 2026-11-06) — a Management-rejected attendance
// case is terminal for its own request. A second chance is therefore a second,
// linked case: the rejected row keeps its decision, note, deduction and audit,
// is marked SUPERSEDED, and a new case with the same day/type/evidence is
// raised through the ordinary HR verification → Management route.
//
// These tests pin the properties payroll and re-evaluation depend on:
//   • the decision history is never rewritten or deleted;
//   • the appeal is an unraised PENDING case with its own source reference;
//   • re-evaluation neither closes the appeal nor duplicates the superseded row
//     (which would collide on (tenantId, sourceKind, sourceRef));
//   • one day can only ever be charged once.
import { describe, it, expect } from "@jest/globals";
import { captureDb, TENANT } from "../helpers/captureDb.js";
import { openAppealCase } from "../../src/services/attendanceRules.service.js";
import { syncRuleCases } from "../../src/services/attendanceRuleCases.service.js";
import { ruleDeductions } from "../../src/lib/attendanceAnomalyRules.js";

const DAY = new Date("2026-10-23T00:00:00.000Z");
const hr = { tenantId: TENANT, userId: "hr-user", employeeId: 2, roles: ["HR"] };
const employee = {
  tenantId: TENANT,
  userId: "emp-1",
  employeeId: 1,
  roles: ["Employee"],
};
const stranger = {
  tenantId: TENANT,
  userId: "emp-3",
  employeeId: 3,
  roles: ["Employee"],
};

const rejected = (extra = {}) => ({
  id: 1,
  tenantId: TENANT,
  employeeId: 1,
  date: DAY,
  type: "LATE_CHECKIN",
  status: "REJECTED",
  decisionRole: "Management",
  evidenceState: "ACTIVE",
  rulesVersion: 2,
  sessionKey: "shift-1",
  factHash: "hash-1",
  // The evidence the rejection priced: a late check-in of 35 minutes.
  measuredMinutes: 35,
  workflowVersion: 4,
  reason: "he had an accident and had to visit doctor.",
  reviewNote: "Unexcused late arrival",
  decidedAt: new Date("2026-11-06T00:45:01.471Z"),
  manualDeductionDays: null,
  approvalPolicy: "STANDARD",
  positionSnapshot: "Team Leader",
  departmentSnapshot: "Fiber (Operation & Maintenance)",
  ...extra,
});

function fixture(seed = {}) {
  return captureDb({
    employee: [
      {
        id: 1,
        tenant_id: TENANT,
        employee_code: "EMP-1",
        employee_name: "Shehroz Abdul Ghafoor",
        managerId: 4,
      },
      { id: 2, tenant_id: TENANT, employee_code: "EMP-2", employee_name: "Afsha Khan" },
      { id: 3, tenant_id: TENANT, employee_code: "EMP-3", employee_name: "Someone Else" },
    ],
    attendanceAnomaly: [rejected()],
    ...seed,
  });
}

describe("appeal of a Management-rejected attendance case", () => {
  it("opens a linked case and keeps the rejection as history", async () => {
    const db = fixture();
    const appealId = await openAppealCase(
      {
        user: hr,
        anomalyId: 1,
        reason: "Doctor visit; ask Management to reconsider with the medical note",
        onBehalf: true,
      },
      db,
    );

    const rows = db.snapshot().attendanceAnomaly;
    expect(rows).toHaveLength(2);
    const original = rows.find((row) => row.id === 1);
    const appeal = rows.find((row) => row.id === appealId);

    // The decision itself is untouched; only its evidence state says history.
    expect(original).toMatchObject({
      status: "REJECTED",
      decisionRole: "Management",
      reviewNote: "Unexcused late arrival",
      decidedAt: new Date("2026-11-06T00:45:01.471Z"),
      evidenceState: "SUPERSEDED",
      workflowVersion: 5,
    });

    // The appeal is an ordinary unraised case for the same fact.
    expect(appeal).toMatchObject({
      employeeId: 1,
      date: DAY,
      type: "LATE_CHECKIN",
      sessionKey: "shift-1",
      factHash: "hash-1",
      rulesVersion: 2,
      status: "PENDING",
      evidenceState: "ACTIVE",
      sourceKind: "APPEAL",
      sourceRef: "appeal:1",
      appealOfAnomalyId: 1,
      positionSnapshot: "Team Leader",
      departmentSnapshot: "Fiber (Operation & Maintenance)",
    });
    expect(appeal.reviewNote ?? null).toBeNull();
    expect(appeal.decisionRole ?? null).toBeNull();

    const audit = db.snapshot().attendanceRuleAudit;
    const opened = audit.find((row) => row.action === "APPEAL_OPENED");
    const superseded = audit.find(
      (row) => row.action === "CASE_SUPERSEDED_BY_APPEAL",
    );
    expect(opened).toMatchObject({ anomalyId: appealId, employeeId: 1 });
    expect(opened.data.originalAnomalyId).toBe(1);
    expect(opened.data.originalDecision.reviewNote).toBe("Unexcused late arrival");
    expect(superseded).toMatchObject({ anomalyId: 1, employeeId: 1 });
    expect(superseded.data.appealId).toBe(appealId);
  });

  it("lets the employee appeal their own case, but not a colleague's", async () => {
    const db = fixture();
    await expect(
      openAppealCase({ user: stranger, anomalyId: 1, reason: "Not my case" }, db),
    ).rejects.toThrow("outside your scope");
    const appealId = await openAppealCase(
      { user: employee, anomalyId: 1, reason: "I was at the hospital" },
      db,
    );
    expect(db.snapshot().attendanceAnomaly.find((row) => row.id === appealId)).toMatchObject({
      status: "PENDING",
      appealOfAnomalyId: 1,
    });
  });

  it("allows one open appeal per rejected case", async () => {
    const db = fixture();
    await openAppealCase({ user: hr, anomalyId: 1, reason: "First", onBehalf: true }, db);
    await expect(
      openAppealCase({ user: hr, anomalyId: 1, reason: "Second", onBehalf: true }, db),
    ).rejects.toThrow("already has an appeal");
  });

  it("refuses a case that is not a live Management rejection", async () => {
    for (const override of [
      { status: "PENDING", decisionRole: null },
      { status: "APPROVED" },
      { evidenceState: "RESOLVED" },
      { rulesVersion: 1 },
    ]) {
      const db = fixture({ attendanceAnomaly: [rejected(override)] });
      await expect(
        openAppealCase({ user: hr, anomalyId: 1, reason: "Try", onBehalf: true }, db),
      ).rejects.toThrow();
      expect(db.snapshot().attendanceAnomaly[0].evidenceState).not.toBe(
        "SUPERSEDED",
      );
    }
  });

  it("requires a reason", async () => {
    const db = fixture();
    await expect(
      openAppealCase({ user: hr, anomalyId: 1, reason: "  ", onBehalf: true }, db),
    ).rejects.toThrow("reason is required");
  });

  it("does not let HR appeal a case about their own day", async () => {
    const db = fixture({
      attendanceAnomaly: [rejected({ employeeId: 2, id: 1 })],
    });
    await expect(
      openAppealCase({ user: hr, anomalyId: 1, reason: "My own day", onBehalf: true }, db),
    ).rejects.toThrow("your own account");
    expect(db.snapshot().attendanceAnomaly[0].evidenceState).toBe("ACTIVE");
  });

  it("survives re-evaluation: no closure, no duplicate live case", async () => {
    const db = fixture();
    const appealId = await openAppealCase(
      { user: hr, anomalyId: 1, reason: "Reconsider", onBehalf: true },
      db,
    );
    await syncRuleCases(db, {
      tenantId: TENANT,
      employeeId: 1,
      day: DAY,
      sessions: [],
      now: new Date("2026-11-07T00:00:00.000Z"),
    });
    const rows = db.snapshot().attendanceAnomaly;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 1).evidenceState).toBe("SUPERSEDED");
    expect(rows.find((row) => row.id === appealId)).toMatchObject({
      status: "PENDING",
      evidenceState: "ACTIVE",
    });
    // The live source reference is represented once, by the appeal.
    expect(rows.filter((row) => row.sourceRef === "rules-v2:1:shift-1:LATE_CHECKIN")).toHaveLength(0);
  });

  it("prices one day once, whichever side of the appeal is active", () => {
    const superseded = rejected({ evidenceState: "SUPERSEDED" });
    const appeal = {
      ...rejected(),
      id: 2,
      sourceKind: "APPEAL",
      sourceRef: "appeal:1",
      appealOfAnomalyId: 1,
      status: "PENDING",
      decisionRole: null,
      reviewNote: null,
    };
    expect(ruleDeductions([superseded, appeal]).days).toBe(0);
    expect(
      ruleDeductions([
        superseded,
        { ...appeal, status: "REJECTED", decisionRole: "Management" },
      ]).days,
    ).toBe(0.5);
  });
});
