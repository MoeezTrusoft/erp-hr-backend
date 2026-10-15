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
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { submitApproval, actApproval, listApprovals, readApproval } =
  await import("../../src/services/approval/service.js");
const { registry, requireApproval } =
  await import("../../src/services/approval/adapters.js");
const { applyEvaluatedShifts } =
  await import("../../src/services/attendanceWriter.service.js");
const { HR_APPROVAL_KINDS } = await import("@trusoft/contracts/hr-approval");
const company = randomUUID(),
  other = randomUUID(),
  people = {};
let counter = 0,
  profile,
  policy;
const db = (fn) =>
  mcpCtx.run({ user: { tenantId: company } }, () =>
    tenantTransaction(prisma, fn, {
      tenantId: company,
      txOptions: { timeout: 60000 },
    }),
  );
const grants = {
  EMPLOYEE: ["self"],
  MANAGER: ["self", "manager"],
  HR: ["self", "verify", "read"],
  MANAGEMENT: ["self", "approve", "read"],
  OTHER: ["self"],
  ADMIN: [],
};
const as = (role, fn, tenantId = company) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId,
        userId: people[role].userId,
        isAdmin: role === "ADMIN",
      },
      permissions: grants[role].map((k) => "hr.approvals." + k),
    },
    fn,
  );
const submit = (s, version = 0) =>
  as("EMPLOYEE", () =>
    submitApproval({
      kind: s.kind,
      sourceRef: s.ref,
      employeeCode: people.EMPLOYEE.employee_code,
      expectedVersion: version,
      reason: "Employee confirms this request and its evidence",
      requestKey: randomUUID(),
    }),
  ).then((r) => r.record);
const act = (who, row, action, extra = {}) =>
  as(who, () =>
    actApproval({
      approvalRef: row.approvalRef,
      expectedVersion: row.version,
      action,
      reason: `${who} ${action}: evidence reviewed`,
      requestKey: randomUUID(),
      ...extra,
    }),
  ).then((r) => r.record);
async function fixture(kind) {
  if (kind === "TIME_CREDIT_REVOCATION") {
    const original = await fixture("TIME_CREDIT");
    let a = await submit(original);
    a = await act("MANAGER", a, "RECOMMEND_APPROVAL");
    a = await act("HR", a, "VERIFY");
    await act("MANAGEMENT", a, "APPROVE");
    return { ...original, kind };
  }
  if (kind === "LOAN_WRITEOFF") {
    const original = await fixture("LOAN");
    let a = await submit(original);
    a = await act("MANAGER", a, "RECOMMEND_APPROVAL");
    a = await act("HR", a, "VERIFY");
    await act("MANAGEMENT", a, "APPROVE");
    return { ...original, kind };
  }
  const n = ++counter,
    date = new Date(Date.UTC(2026, 9, 1 + n)),
    end = new Date(+date + 3600000);
  let row;
  await db(async (tx) => {
    const base = { tenantId: company, employeeId: people.EMPLOYEE.id };
    if (kind === "TIME_CREDIT") {
      row = await tx.attendanceTimeCredit.create({
        data: {
          ...base,
          date,
          kind: "TRAVEL",
          start: new Date(+date + 12 * 3600000),
          end: new Date(+date + 13 * 3600000),
          fromSiteId: "HO",
          toSiteId: "SITE",
          paid: true,
          reason: "Fictional travel",
          state: "PENDING",
          approvedBy: "",
        },
      });
      for (const [hour, status, siteId] of [
        [9, 0, "HO"],
        [12, 1, "HO"],
        [13, 0, "SITE"],
        [17, 1, "SITE"],
      ])
        await tx.attendanceDevicePunch.create({
          data: {
            ...base,
            sn: "TEST-DEVICE",
            siteId,
            deviceUserId: "101",
            punchedAt: new Date(+date + hour * 3600000),
            status,
            directionVerified: true,
          },
        });
    }
    if (kind === "LEAVE")
      row = await tx.leaveRequest.create({
        data: {
          ...base,
          startDate: date,
          endDate: date,
          totalDays: 1,
          reason: "Fictional leave",
          createdById: people.EMPLOYEE.id,
          leavePolicyId: policy.id,
        },
      });
    if (kind === "OVERTIME") {
      row = await tx.overtimeRequest.create({
        data: { ...base, date, hours: 2, reason: "Fictional overtime" },
      });
      await tx.shiftAssignment.create({ data: { ...base, date } });
    }
    if (kind === "CLAIM") {
      row = await tx.reimbursementClaim.create({
        data: {
          ...base,
          title: "Fictional expense",
          amount: 125,
          currency: "PKR",
        },
      });
      await tx.claimItem.create({
        data: {
          tenantId: company,
          claimId: row.id,
          name: "Travel",
          amount: 125,
        },
      });
    }
    if (kind === "LOAN")
      row = await tx.loan.create({
        data: {
          ...base,
          principalMinor: 12000,
          outstandingMinor: 12000,
          tenureMonths: 12,
          monthlyInstallmentMinor: 1000,
          disbursementDate: date,
        },
      });
    if (kind === "TIMESHEET") {
      row = await tx.timesheet.create({
        data: { ...base, period_start: date, period_end: end, total_hours: 1 },
      });
      await tx.timeEntry.create({
        data: {
          ...base,
          timesheetId: row.id,
          start_time: date,
          end_time: end,
          work_date: date,
          duration_minutes: 60,
          entry_type: "MANUAL_ENTRY",
        },
      });
    }
    if (kind === "SHIFT_SWAP")
      row = await tx.shiftSwapRequest.create({
        data: {
          tenantId: company,
          requesterId: base.employeeId,
          targetId: people.OTHER.id,
          fromDate: date,
          toDate: end,
          reason: "Fictional swap",
        },
      });
    if (kind === "GOAL")
      row = await tx.goal.create({
        data: {
          ...base,
          title: "Fictional goal",
          start_date: date,
          end_date: end,
          target_value: 10,
        },
      });
    if (kind === "REQUISITION")
      row = await tx.jobRequisition.create({
        data: {
          tenantId: company,
          requestedById: base.employeeId,
          title: "Fictional vacancy",
        },
      });
    if (kind === "PAYROLL")
      row = await tx.payrollRun.create({
        data: {
          tenantId: company,
          processedBy: base.employeeId,
          periodStart: new Date(Date.UTC(2030, 0, n)),
          periodEnd: new Date(Date.UTC(2030, 0, n, 23)),
          countryCode: "PK",
          currencyCode: "PKR",
          status: "COMPLETED",
          totalGross: 100,
          totalNet: 100,
        },
      });
    if (kind === "PERFORMANCE")
      row = await tx.performanceReview.create({
        data: {
          ...base,
          overall_rating: 3,
          comments: "Practical evidence recorded",
        },
      });
    if (kind === "ATTENDANCE") {
      for (const [hour, minute, status] of [
        [9, 45, 0],
        [17, 0, 1],
      ])
        await tx.attendanceDevicePunch.create({
          data: {
            ...base,
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
        employeeIds: [base.employeeId],
        db: tx,
        dryRun: false,
        now: new Date(+date + 3 * 86400000),
      });
      row = await tx.attendanceAnomaly.findFirst({
        where: { ...base, date, type: "LATE_CHECKIN", status: "PENDING" },
      });
      assert.ok(row, "evaluation created a late case");
      row = await tx.attendanceAnomaly.update({
        where: { id: row.id },
        data: { reason: "Employee explanation" },
      });
    }
    if (kind === "ASSESSMENT_RELEASE") {
      row = await tx.assessmentAssignment.create({
        data: {
          tenantId: company,
          employeeCode: people.EMPLOYEE.employee_code,
          profileRef: profile.id,
          profileSnapshot: { tasks: [] },
          policySnapshot: {},
          purpose: "PERFORMANCE",
          period: String(n),
          raterCode: people.MANAGER.employee_code,
          reviewerCode: people.HR.employee_code,
          taskCodes: [],
          state: "ACKNOWLEDGED",
          idempotencyKey: randomUUID(),
          inputDigest: "fixture",
          dueAt: date,
        },
      });
      await tx.assessmentRevision.create({
        data: {
          tenantId: company,
          assessmentRef: row.id,
          revisionNo: 1,
          snapshot: { observations: [] },
          digest: "frozen-evidence",
          checksDigest: "checked",
          reviewTier: "FULL",
          sampled: false,
          state: "APPROVED",
        },
      });
    }
    if (["DEVELOPMENT", "JOB_DESCRIPTION"].includes(kind))
      row = await tx.assessmentIntegration.create({
        data: {
          tenantId: company,
          employeeCode: people.EMPLOYEE.employee_code,
          kind: kind === "DEVELOPMENT" ? "DEVELOPMENT" : "JD",
          key: randomUUID(),
          sourceRef: randomUUID(),
          status: kind === "DEVELOPMENT" ? "PROPOSED" : "OWNER_APPROVED",
          payload: { evidence: "observed-task" },
        },
      });
    if (kind === "CATEGORY_CONVERSION")
      row = await tx.employeeCategoryConversion.create({
        data: {
          tenantId: company,
          employeeCode: people.EMPLOYEE.employee_code,
          category: "MANAGEMENT",
          effectiveAt: date,
          reason: "Changed duties",
          requestedByCode: people.HR.employee_code,
        },
      });
    if (
      ["NOTICE_CHANGE", "SEPARATION_WITHDRAWAL", "SETTLEMENT"].includes(kind)
    ) {
      await tx.separation.updateMany({
        where: {
          tenantId: company,
          employeeCode: people.EMPLOYEE.employee_code,
        },
        data: { state: "CANCELLED" },
      });
      const separation = await tx.separation.create({
        data: {
          tenantId: company,
          employeeCode: people.EMPLOYEE.employee_code,
          type: "RESIGNATION",
          state: "NOTICE_PERIOD",
          reasonCode: "PERSONAL",
          reason: "Fictional separation",
          proposedLastWorkingAt: date,
          createdByCode: people.EMPLOYEE.employee_code,
          category: "EMPLOYEE",
          gradeCode: "G1",
          policySnapshot: {},
          documents: [],
        },
      });
      if (kind === "SEPARATION_WITHDRAWAL")
        row = await tx.separation.update({
          where: { id: separation.id },
          data: { withdrawalRequestedAt: new Date() },
        });
      else if (kind === "SETTLEMENT")
        row = await tx.finalSettlementSheet.create({
          data: {
            tenantId: company,
            employeeCode: people.EMPLOYEE.employee_code,
            separationRef: separation.id,
            key: "FINAL",
            status: "PREPARED",
            payload: { netMinor: "10000", currency: "PKR" },
          },
        });
      else
        row = await tx.noticePeriodRecord.create({
          data: {
            tenantId: company,
            employeeCode: people.EMPLOYEE.employee_code,
            separationRef: separation.id,
            key: "NOTICE",
            payload: {
              pending: {
                action: "REQUEST_BUYOUT",
                days: 2,
                reason: "Fictional",
                requestedByCode: people.EMPLOYEE.employee_code,
              },
            },
          },
        });
    }
    if (kind === "OFFER") {
      const requisition = await tx.jobRequisition.create({
        data: {
          tenantId: company,
          requestedById: base.employeeId,
          title: "Fictional vacancy",
        },
      });
      const candidate = await tx.candidate.create({
        data: {
          tenantId: company,
          firstName: "Fictional",
          email: randomUUID() + "@example.invalid",
        },
      });
      const application = await tx.application.create({
        data: {
          tenantId: company,
          candidateId: candidate.id,
          jobRequisitionId: requisition.id,
        },
      });
      row = await tx.offer.create({
        data: {
          tenantId: company,
          applicationId: application.id,
          candidateId: candidate.id,
          jobRequisitionId: requisition.id,
          salary: "50000",
          createdById: base.employeeId,
        },
      });
    }
  });
  return {
    kind,
    row,
    ref:
      String(row.id) +
      (kind === "ASSESSMENT_RELEASE"
        ? "@1"
        : ["NOTICE_CHANGE", "SETTLEMENT"].includes(kind)
          ? `@${row.version}`
          : kind === "SEPARATION_WITHDRAWAL"
            ? `@${new Date(row.withdrawalRequestedAt).getTime()}`
            : kind === "ATTENDANCE"
              ? `@${row.factHash}`
              : ""),
  };
}

export async function setup() {
  await db(async (tx) => {
    for (const role of Object.keys(grants))
      people[role] = await tx.employee.create({
        data: {
          tenant_id: company,
          employee_code: "EMP-" + role,
          employeeCategory: "EMPLOYEE",
          userId: 100000 + Math.floor(Math.random() * 1e8),
          first_name: "Fictional",
          status: "Active",
          employement_status: "Active",
          hire_date: new Date("2026-01-01"),
        },
      });
    people.EMPLOYEE = await tx.employee.update({
      where: { id: people.EMPLOYEE.id },
      data: { managerId: people.MANAGER.id },
    });
    policy = await tx.leavePolicy.create({
      data: {
        tenantId: company,
        name: "Annual",
        createdById: people.HR.id,
        leaveTypeCode: "ANNUAL",
      },
    });
    await tx.leaveBalance.create({
      data: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        leavePolicyId: policy.id,
        balance: 20,
      },
    });
    profile = await tx.assessmentProfileVersion.create({
      data: {
        tenantId: company,
        profileCode: "TEST",
        profileVersion: 1,
        departmentRef: "ENG",
        categoryCode: "EMPLOYEE",
        positionRef: "ENGINEER",
        definition: {},
        ownerCode: people.HR.employee_code,
        createdByCode: people.HR.employee_code,
      },
    });
    await tx.attendanceSetupRelease.create({
      data: {
        tenantId: company,
        version: 1,
        effectiveFrom: new Date("2026-01-01"),
        coverageThrough: new Date("2027-12-31"),
        reason: "Fictional fixture",
        config: {
          version: 1,
          settings: {
            sites: [{ id: "HO" }, { id: "SITE" }],
            siteAssignments: [
              {
                employeeId: people.EMPLOYEE.id,
                siteIds: ["HO", "SITE"],
                effectiveFrom: "2026-01-01",
              },
            ],
            siteRoutes: [
              { fromSiteId: "HO", toSiteId: "SITE", minimumMinutes: 30 },
            ],
            timeZone: "Asia/Karachi",
            defaultCalendarId: 1,
            profiles: [],
            assignments: [],
          },
          policy: { checkoutLeniencyMin: 240 },
          employees: [
            {
              id: people.EMPLOYEE.id,
              payroll_included: true,
              hire_date: "2026-01-01",
            },
          ],
          periods: [],
          schedules: [
            {
              employeeId: people.EMPLOYEE.id,
              effective_start_date: "2026-01-01",
              schedule_pattern: {
                shift: { from: "09:00", to: "17:00" },
                offDays: [],
              },
            },
          ],
          calendars: [
            { id: 1, year: 2026 },
            { id: 2, year: 2027 },
          ],
          holidays: [],
          calendarAssignments: [],
        },
      },
    });
  });
}

export { prisma, company, other, people, db, as, fixture, submit, act };
