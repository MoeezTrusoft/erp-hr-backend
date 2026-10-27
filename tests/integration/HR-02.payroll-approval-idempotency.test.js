// Native payroll regression: calculation, idempotency and independent Approval Centre review.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import prisma from "../../src/lib/prisma.js";
import * as payroll from "../../src/services/payrollService.js";
import { publishConfig } from "../../src/services/payrollConfigActions.service.js";
import { submitApproval, actApproval } from "../../src/services/approval/service.js";
import { mcpCtx } from "../../src/mcp/context.js";
import { decimalToMinor } from "../../src/lib/money.js";

const TENANT = randomUUID(), people = {}, created = { runs: [], terms: [], taxRates: [] };
let PROCESSOR, APPROVER, dbAvailable = false, periodSeq = 0;
const savedKeys = Object.fromEntries(["HR_C4_ENCRYPTION_KEY", "HR_C4_BLIND_INDEX_KEY"].map(k => [k, process.env[k]]));
const grants = { PROCESSOR: ["self"], MANAGER: ["self", "manager"], HR: ["self", "verify", "read"], MANAGEMENT: ["self", "approve", "read"] };
const as = (role, fn) => mcpCtx.run({ actorVerified: true,
    user: { tenantId: TENANT, userId: people[role].userId },
    permissions: grants[role].map(k => "hr.approvals." + k),
}, fn);
const submit = run => as("PROCESSOR", () => submitApproval({ kind: "PAYROLL", sourceRef: String(run.id),
    employeeCode: people.PROCESSOR.employee_code, expectedVersion: 0,
    reason: "Payroll calculation and evidence reviewed", requestKey: randomUUID(),
})).then(r => r.record);
const act = (role, review, action) => as(role, () => actApproval({ approvalRef: review.approvalRef,
    expectedVersion: review.version, action, reason: role + " independently reviewed payroll evidence", requestKey: randomUUID(),
})).then(r => r.record);

beforeAll(async () => mcpCtx.run({ system: true }, async () => {
    for (const key of Object.keys(savedKeys)) process.env[key] ||= randomBytes(32).toString("base64");
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
    for (const role of Object.keys(grants)) people[role] = await prisma.employee.create({ data: {
        employee_code: "PAY-" + role + "-" + randomUUID().slice(0,8).toUpperCase(), employeeCategory: "EMPLOYEE",
        tenant_id: TENANT, first_name: "Fictional", last_name: role, status: "Active", employement_status: "Active",
        userId: 100000 + Math.floor(Math.random() * 1e8), payroll_included: role === "PROCESSOR", hire_date: new Date("2097-01-01"),
    } });
    PROCESSOR = people.PROCESSOR.id;
    APPROVER = people.MANAGEMENT.id;
    await prisma.employee.update({ where: { id: PROCESSOR }, data: { managerId: people.MANAGER.id } });
    created.terms.push((await prisma.employmentTerms.create({ data: { tenantId: TENANT, employeeId: PROCESSOR,
        baseSalary: 5000, currency: "USD", payFrequency: "MONTHLY", effectiveFrom: new Date("2097-01-01"),
    } })).id);
    await prisma.bankDetail.create({ data: { tenantId: TENANT, employeeId: PROCESSOR, bankName: "Fictional bank",
        accountNumber: "TEST-" + randomUUID(), routingNumber: "TEST-ROUTING", isPrimary: true,
    } });
    for (const [bracketMin, bracketMax, rate] of [[0,3000,0.1],[3000,null,0.2]]) created.taxRates.push((await prisma.taxRate.create({
        data: { tenantId: TENANT, countryCode: "US", bracketMin, bracketMax, rate, status: "ACTIVE", effectiveFrom: new Date("2097-01-01") },
    })).id);
    await prisma.attendanceSetupRelease.create({ data: {
        tenantId: TENANT, version: 1, effectiveFrom: new Date("2097-01-01"), coverageThrough: new Date("2097-12-31"),
        reason: "Fictional published payroll attendance coverage",
        config: { version: 1,
            settings: { timeZone: "UTC", defaultCalendarId: 1, profiles: [], assignments: [], sites: [{ id: "TEST" }],
                siteAssignments: [{ employeeId: PROCESSOR, siteIds: ["TEST"], effectiveFrom: "2097-01-01" }], siteRoutes: [] },
            policy: { checkoutLeniencyMin: 240 }, employees: [{ id: PROCESSOR, payroll_included: true, hire_date: "2097-01-01" }],
            periods: [], schedules: [{ employeeId: PROCESSOR, effective_start_date: "2097-01-01",
                schedule_pattern: { shift: { from: "09:00", to: "17:00" }, offDays: [] } }],
            calendars: [{ id: 1, year: 2097 }], holidays: [], calendarAssignments: [],
        },
    } });
    await publishConfig({ tenantId: TENANT, publishedById: PROCESSOR });
}), 60000);

afterAll(async () => {
    // The uniquely named fixture company lives only in the disposable test DB.
    // Approval history is immutable, including in tests; keep its source rows
    // instead of disabling audit protections to clean up an individual suite.
    for (const [key, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await prisma.$disconnect();
}, 30000);
const guard = () => !dbAvailable;
const freshRun = async () => mcpCtx.run({ system: true }, async () => {
    const month = periodSeq++, start = new Date(Date.UTC(2097, month, 1)), end = new Date(Date.UTC(2097, month + 1, 0));
    const run = await payroll.createPayrollRun({ periodStart: start, periodEnd: end, countryCode: "US", currencyCode: "USD" }, PROCESSOR, TENANT);
    created.runs.push(run.id);
    await prisma.payrollAuditLog.create({ data: { tenantId: TENANT, payrollRunId: run.id, action: "TIMESHEET_SUBMITTED",
        details: "Fictional verified timesheet " + start.toISOString().slice(0,7), employeeId: PROCESSOR,
    } });
    return run;
});

describe('HR-02 approval gate + idempotency (real engine, live DB)', () => {
    it('processing records the processor, rule version, and table-driven tax (not 15/5)', async () => mcpCtx.run({ system: true }, async () => {
        if (guard()) return;
        const run = await freshRun();

        const processed = await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        expect(processed.status).toBe('COMPLETED');
        expect(processed.processedBy).toBe(PROCESSOR);
        expect(processed.ruleVersion).toBeTruthy();
        expect(processed.ratesEffectiveAt).toBeTruthy();

        const slip = processed.payslips[0];
        // gross 5000 → progressive tax = 10% of 3000 + 20% of 2000 = 300 + 400 = 700
        // legacy flat (15+5)%*5000 = 1000 → assert it is the table figure, not 1000.
        // Decimal(18,4) columns deserialize as exact decimal strings — compare in
        // exact minor units via the money lib (never float arithmetic).
        const taxMinor = slip.deductions
            .filter((d) => /tax/i.test(d.description))
            .reduce((acc, d) => acc + decimalToMinor(d.amount, 'USD'), 0n);
        expect(taxMinor).toBe(70000n);
        expect(taxMinor).not.toBe(100000n);
        expect(slip.ruleVersion).toBe(processed.ruleVersion);
    }));

    it('re-processing the SAME run is idempotent — no duplicate payslips, no doubled totals', async () => mcpCtx.run({ system: true }, async () => {
        if (guard()) return;
        const run = await freshRun();

        const first = await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        const firstCount = first.payslips.length;
        const firstNet = first.totalNet;

        const again = await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        expect(again.payslips.length).toBe(firstCount);
        // totalNet is a Prisma Decimal instance — compare exact string form.
        expect(String(again.totalNet)).toBe(String(firstNet));

        const slips = await prisma.payrollPayslip.count({ where: { payrollRunId: run.id } });
        expect(slips).toBe(firstCount);
    }));

    it('FINALIZE is BLOCKED without an approval', async () => mcpCtx.run({ system: true }, async () => {
        if (guard()) return;
        const run = await freshRun();
        await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        await expect(payroll.finalizePayrollRun(run.id, PROCESSOR, TENANT)).rejects.toThrow(/approv/i);
    }));

    it('Approval Centre refuses self-review by the payroll initiator', async () => mcpCtx.run({ system: true }, async () => {
        if (guard()) return;
        const run = await freshRun();
        await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        const review = await submit(run);
        await expect(as("PROCESSOR", () => actApproval({ approvalRef: review.approvalRef, expectedVersion: review.version,
            action: "RECOMMEND_APPROVAL", reason: "Attempted self review", requestKey: randomUUID() })))
            .rejects.toThrow();
        expect((await prisma.payrollRun.findUnique({ where: { id: run.id } })).status).toBe("COMPLETED");
    }));

    it('FINALIZE SUCCEEDS with a DISTINCT approver', async () => mcpCtx.run({ system: true }, async () => {
        if (guard()) return;
        const run = await freshRun();
        await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);

        let review = await submit(run);
        review = await act("MANAGER", review, "RECOMMEND_APPROVAL");
        review = await act("HR", review, "VERIFY");
        await act("MANAGEMENT", review, "APPROVE");
        const approved = await prisma.payrollRun.findUnique({ where: { id: run.id } });
        expect(approved.approvedBy).toBe(APPROVER);
        expect(approved.status).toBe('APPROVED');

        const finalized = await as("HR", () => payroll.finalizePayrollRun(run.id, people.HR.id, TENANT));
        expect(finalized.status).toBe('FINALIZED');
        const slipStatuses = finalized.payslips.map((p) => p.status);
        expect(slipStatuses.every((s) => s === 'FINALIZED')).toBe(true);
    }));
});
