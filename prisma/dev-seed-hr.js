/**
 * Dev HR seed — modest, internally-consistent dataset for the dev tenant so the
 * live HR list tools (mcpList*) return coherent rows after the mock→live bind.
 *
 * Run:  node prisma/dev-seed-hr.js
 *
 * IDEMPOTENT: every write is an upsert / skip-if-present keyed on a stable
 * natural key, so re-running adds NO duplicates. All rows carry the dev tenant
 * (14c350e8-d0bc-4ee9-90c7-dea2b7a7a007). Referentially consistent:
 *   - employees sit in a real department + position + grade, with a manager in
 *     the right dept and tenure consistent with the join date;
 *   - candidates apply to real requisitions with a coherent pipeline status;
 *   - leave requests reference real employees + real leave policies, with
 *     non-overlapping date ranges and sensible statuses;
 *   - payslips are one-per-employee for a run with net = gross - deductions;
 *   - performance reviews reference real employees + their manager as reviewer.
 *
 * We import the SINGLETON client (src/lib/prisma.js) so the C4 encryption
 * extension is applied on write exactly as the app expects (ARCH-01 §5.3).
 */
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js"; // run the seed under a tenant context so FORCE-RLS writes pass

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";

// ── helpers ──────────────────────────────────────────────────────────────────
const d = (s) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date("2026-06-28T00:00:00.000Z");

function monthsBetween(from, to) {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}

// inclusive whole-day span between two dates
function dayspan(start, end) {
  return Math.round((d(end) - d(start)) / 86_400_000) + 1;
}

async function getOrCreate(model, find, create) {
  const existing = await prisma[model].findFirst({ where: find });
  if (existing) return existing;
  return prisma[model].create({ data: create });
}

// Prisma 7 (strict) rejects a non-unique `where` in upsert. This idempotent
// helper replicates upsert semantics keyed on an arbitrary (non-unique) filter:
// find-by-filter → update-by-id if present, else create. Returns the row, so the
// call-site shape is identical to the upsert it replaces.
async function upsertBy(model, where, createData, updateData) {
  const existing = await prisma[model].findFirst({ where });
  if (existing) return prisma[model].update({ where: { id: existing.id }, data: updateData });
  return prisma[model].create({ data: createData });
}

// ── 1. Departments (BusinessUnit) ────────────────────────────────────────────
const DEPARTMENTS = [
  "Engineering",
  "Human Resources",
  "Sales",
  "Finance",
  "Operations",
];

// ── 2. Grade levels ───────────────────────────────────────────────────────────
const GRADES = [
  { name: "G1", description: "Associate" },
  { name: "G2", description: "Senior" },
  { name: "G3", description: "Lead" },
  { name: "G4", description: "Manager" },
  { name: "G5", description: "Director" },
];

// ── 3. Positions (jobCode is @unique) ─────────────────────────────────────────
const POSITIONS = [
  { jobCode: "ENG-SWE", title: "Software Engineer", dept: "Engineering" },
  { jobCode: "ENG-SSE", title: "Senior Software Engineer", dept: "Engineering" },
  { jobCode: "ENG-MGR", title: "Engineering Manager", dept: "Engineering" },
  { jobCode: "HR-GEN", title: "HR Generalist", dept: "Human Resources" },
  { jobCode: "HR-MGR", title: "HR Manager", dept: "Human Resources" },
  { jobCode: "SAL-EXE", title: "Sales Executive", dept: "Sales" },
  { jobCode: "SAL-MGR", title: "Sales Manager", dept: "Sales" },
  { jobCode: "FIN-ACC", title: "Accountant", dept: "Finance" },
  { jobCode: "FIN-MGR", title: "Finance Manager", dept: "Finance" },
  { jobCode: "OPS-ANL", title: "Operations Analyst", dept: "Operations" },
  { jobCode: "OPS-MGR", title: "Operations Manager", dept: "Operations" },
];

// ── 4. Employees (25) ─────────────────────────────────────────────────────────
// mgr = employee_code of the direct manager (a G4 in the same department).
const EMPLOYEES = [
  // Engineering
  { code: "DEV-001", first: "Imran", last: "Sheikh", dept: "Engineering", job: "ENG-MGR", grade: "G4", joined: "2019-03-01", mgr: null },
  { code: "DEV-002", first: "Ahmed", last: "Raza", dept: "Engineering", job: "ENG-SSE", grade: "G2", joined: "2020-06-15", mgr: "DEV-001" },
  { code: "DEV-003", first: "Bilal", last: "Hussain", dept: "Engineering", job: "ENG-SSE", grade: "G2", joined: "2021-01-10", mgr: "DEV-001" },
  { code: "DEV-004", first: "Hassan", last: "Iqbal", dept: "Engineering", job: "ENG-SWE", grade: "G1", joined: "2022-09-05", mgr: "DEV-001" },
  { code: "DEV-005", first: "Maria", last: "Yousaf", dept: "Engineering", job: "ENG-SWE", grade: "G1", joined: "2023-02-20", mgr: "DEV-001" },
  { code: "DEV-006", first: "Usman", last: "Tariq", dept: "Engineering", job: "ENG-SWE", grade: "G1", joined: "2023-08-01", mgr: "DEV-001" },
  { code: "DEV-024", first: "Junaid", last: "Akhtar", dept: "Engineering", job: "ENG-SWE", grade: "G1", joined: "2024-01-08", mgr: "DEV-001" },
  // Human Resources
  { code: "DEV-007", first: "Fatima", last: "Khan", dept: "Human Resources", job: "HR-MGR", grade: "G4", joined: "2018-11-12", mgr: null },
  { code: "DEV-008", first: "Sana", last: "Malik", dept: "Human Resources", job: "HR-GEN", grade: "G1", joined: "2021-05-03", mgr: "DEV-007" },
  { code: "DEV-009", first: "Hina", last: "Aslam", dept: "Human Resources", job: "HR-GEN", grade: "G1", joined: "2022-07-18", mgr: "DEV-007" },
  { code: "DEV-025", first: "Areeba", last: "Khan", dept: "Human Resources", job: "HR-GEN", grade: "G1", joined: "2024-02-19", mgr: "DEV-007" },
  // Sales
  { code: "DEV-010", first: "Omar", last: "Farooq", dept: "Sales", job: "SAL-MGR", grade: "G4", joined: "2019-09-23", mgr: null },
  { code: "DEV-011", first: "Zain", last: "Ali", dept: "Sales", job: "SAL-EXE", grade: "G2", joined: "2020-12-01", mgr: "DEV-010" },
  { code: "DEV-012", first: "Ayesha", last: "Siddiqui", dept: "Sales", job: "SAL-EXE", grade: "G1", joined: "2022-03-14", mgr: "DEV-010" },
  { code: "DEV-013", first: "Bilal", last: "Ahmed", dept: "Sales", job: "SAL-EXE", grade: "G1", joined: "2023-04-10", mgr: "DEV-010" },
  { code: "DEV-014", first: "Nida", last: "Riaz", dept: "Sales", job: "SAL-EXE", grade: "G1", joined: "2023-10-02", mgr: "DEV-010" },
  // Finance
  { code: "DEV-015", first: "Saad", last: "Mahmood", dept: "Finance", job: "FIN-MGR", grade: "G4", joined: "2018-06-30", mgr: null },
  { code: "DEV-016", first: "Kiran", last: "Shah", dept: "Finance", job: "FIN-ACC", grade: "G2", joined: "2020-08-19", mgr: "DEV-015" },
  { code: "DEV-017", first: "Tariq", last: "Jameel", dept: "Finance", job: "FIN-ACC", grade: "G1", joined: "2022-01-25", mgr: "DEV-015" },
  { code: "DEV-018", first: "Sadia", last: "Noor", dept: "Finance", job: "FIN-ACC", grade: "G1", joined: "2023-06-12", mgr: "DEV-015" },
  // Operations
  { code: "DEV-019", first: "Adnan", last: "Qureshi", dept: "Operations", job: "OPS-MGR", grade: "G4", joined: "2019-02-11", mgr: null },
  { code: "DEV-020", first: "Rabia", last: "Aslam", dept: "Operations", job: "OPS-ANL", grade: "G2", joined: "2021-03-30", mgr: "DEV-019" },
  { code: "DEV-021", first: "Faisal", last: "Mehmood", dept: "Operations", job: "OPS-ANL", grade: "G1", joined: "2022-11-08", mgr: "DEV-019" },
  { code: "DEV-022", first: "Hamza", last: "Saeed", dept: "Operations", job: "OPS-ANL", grade: "G1", joined: "2023-05-22", mgr: "DEV-019" },
  { code: "DEV-023", first: "Mehwish", last: "Tariq", dept: "Operations", job: "OPS-ANL", grade: "G1", joined: "2023-09-15", mgr: "DEV-019" },
];

// gross monthly pay by grade (PKR) — drives payslip arithmetic
const GROSS_BY_GRADE = { G1: 120000, G2: 180000, G3: 250000, G4: 350000, G5: 500000 };

// ── 5. Leave policies (leave types) ───────────────────────────────────────────
const LEAVE_POLICIES = [
  { name: "Annual Leave", leaveTypeCode: "AL", accrualRate: 1.75, accrualPeriod: "MONTHLY" },
  { name: "Sick Leave", leaveTypeCode: "SL", accrualRate: 0.83, accrualPeriod: "MONTHLY" },
  { name: "Casual Leave", leaveTypeCode: "CL", accrualRate: 0.83, accrualPeriod: "MONTHLY" },
  { name: "Unpaid Leave", leaveTypeCode: "UL", accrualRate: 0.0, accrualPeriod: "NONE" },
];

// ── 6. Requisitions (10) — unique titles for idempotent keying ────────────────
const REQUISITIONS = [
  { title: "Software Engineer - Platform Team", job: "ENG-SWE", dept: "Engineering", reqBy: "DEV-001", status: "POSTED", openings: 2, approvedBy: "DEV-007" },
  { title: "Senior Software Engineer - Core", job: "ENG-SSE", dept: "Engineering", reqBy: "DEV-001", status: "APPROVED", openings: 1, approvedBy: "DEV-007" },
  { title: "Software Engineer - Mobile Team", job: "ENG-SWE", dept: "Engineering", reqBy: "DEV-001", status: "POSTED", openings: 1, approvedBy: "DEV-007" },
  { title: "Sales Executive - Enterprise", job: "SAL-EXE", dept: "Sales", reqBy: "DEV-010", status: "POSTED", openings: 3, approvedBy: "DEV-007" },
  { title: "Sales Executive - SMB", job: "SAL-EXE", dept: "Sales", reqBy: "DEV-010", status: "CLOSED", openings: 1, approvedBy: "DEV-007" },
  { title: "Accountant - Payables", job: "FIN-ACC", dept: "Finance", reqBy: "DEV-015", status: "PENDING_APPROVAL", openings: 1, approvedBy: null },
  { title: "Operations Analyst - Logistics", job: "OPS-ANL", dept: "Operations", reqBy: "DEV-019", status: "POSTED", openings: 2, approvedBy: "DEV-007" },
  { title: "HR Generalist - People Ops", job: "HR-GEN", dept: "Human Resources", reqBy: "DEV-007", status: "CLOSED", openings: 1, approvedBy: "DEV-007" },
  { title: "Engineering Manager - Data", job: "ENG-MGR", dept: "Engineering", reqBy: "DEV-001", status: "DRAFT", openings: 1, approvedBy: null },
  { title: "Finance Manager - FP&A", job: "FIN-MGR", dept: "Finance", reqBy: "DEV-015", status: "DRAFT", openings: 1, approvedBy: null },
];

// ── 7. Candidates (15) + their application to a real requisition ──────────────
// stage pipeline is coherent: hired only on CLOSED reqs; rejected/offer/etc on open.
const CANDIDATES = [
  { first: "Daniyal", last: "Aziz", email: "daniyal.aziz@example.com", source: "LinkedIn", req: "Software Engineer - Platform Team", stage: "interview", appStatus: "open" },
  { first: "Mahnoor", last: "Shah", email: "mahnoor.shah@example.com", source: "Referral", req: "Software Engineer - Platform Team", stage: "screening", appStatus: "open" },
  { first: "Talha", last: "Rauf", email: "talha.rauf@example.com", source: "Job Board", req: "Software Engineer - Mobile Team", stage: "applied", appStatus: "open" },
  { first: "Iqra", last: "Hameed", email: "iqra.hameed@example.com", source: "LinkedIn", req: "Senior Software Engineer - Core", stage: "offer", appStatus: "open" },
  { first: "Waleed", last: "Asif", email: "waleed.asif@example.com", source: "Referral", req: "Senior Software Engineer - Core", stage: "rejected", appStatus: "closed" },
  { first: "Komal", last: "Javed", email: "komal.javed@example.com", source: "Job Board", req: "Sales Executive - Enterprise", stage: "interview", appStatus: "open" },
  { first: "Shahzad", last: "Anwar", email: "shahzad.anwar@example.com", source: "LinkedIn", req: "Sales Executive - Enterprise", stage: "screening", appStatus: "open" },
  { first: "Rida", last: "Fatima", email: "rida.fatima@example.com", source: "Career Fair", req: "Sales Executive - Enterprise", stage: "applied", appStatus: "open" },
  { first: "Noman", last: "Bashir", email: "noman.bashir@example.com", source: "Referral", req: "Sales Executive - SMB", stage: "hired", appStatus: "closed" },
  { first: "Sania", last: "Iqbal", email: "sania.iqbal@example.com", source: "LinkedIn", req: "Operations Analyst - Logistics", stage: "interview", appStatus: "open" },
  { first: "Arsalan", last: "Malik", email: "arsalan.malik@example.com", source: "Job Board", req: "Operations Analyst - Logistics", stage: "applied", appStatus: "open" },
  { first: "Hareem", last: "Zafar", email: "hareem.zafar@example.com", source: "Referral", req: "HR Generalist - People Ops", stage: "hired", appStatus: "closed" },
  { first: "Yasir", last: "Nadeem", email: "yasir.nadeem@example.com", source: "LinkedIn", req: "Accountant - Payables", stage: "applied", appStatus: "open" },
  { first: "Mariam", last: "Saleem", email: "mariam.saleem@example.com", source: "Career Fair", req: "Operations Analyst - Logistics", stage: "screening", appStatus: "open" },
  { first: "Fahad", last: "Rashid", email: "fahad.rashid@example.com", source: "Job Board", req: "Software Engineer - Mobile Team", stage: "screening", appStatus: "open" },
];

// ── 8. Leave requests (15) — non-overlapping per employee, sensible statuses ──
const LEAVE_REQUESTS = [
  { emp: "DEV-002", policy: "Annual Leave", start: "2026-02-02", end: "2026-02-06", status: "APPROVED" },
  { emp: "DEV-003", policy: "Sick Leave", start: "2026-03-10", end: "2026-03-11", status: "APPROVED" },
  { emp: "DEV-004", policy: "Casual Leave", start: "2026-04-06", end: "2026-04-06", status: "APPROVED" },
  { emp: "DEV-005", policy: "Annual Leave", start: "2026-05-18", end: "2026-05-22", status: "PENDING" },
  { emp: "DEV-006", policy: "Sick Leave", start: "2026-06-01", end: "2026-06-02", status: "APPROVED" },
  { emp: "DEV-008", policy: "Annual Leave", start: "2026-03-23", end: "2026-03-27", status: "APPROVED" },
  { emp: "DEV-009", policy: "Casual Leave", start: "2026-05-04", end: "2026-05-05", status: "REJECTED" },
  { emp: "DEV-011", policy: "Annual Leave", start: "2026-04-13", end: "2026-04-17", status: "APPROVED" },
  { emp: "DEV-012", policy: "Sick Leave", start: "2026-06-08", end: "2026-06-09", status: "PENDING" },
  { emp: "DEV-013", policy: "Unpaid Leave", start: "2026-02-16", end: "2026-02-20", status: "APPROVED" },
  { emp: "DEV-016", policy: "Annual Leave", start: "2026-05-11", end: "2026-05-15", status: "APPROVED" },
  { emp: "DEV-017", policy: "Casual Leave", start: "2026-06-15", end: "2026-06-15", status: "PENDING" },
  { emp: "DEV-020", policy: "Annual Leave", start: "2026-03-02", end: "2026-03-06", status: "APPROVED" },
  { emp: "DEV-021", policy: "Sick Leave", start: "2026-04-20", end: "2026-04-21", status: "REJECTED" },
  { emp: "DEV-022", policy: "Annual Leave", start: "2026-06-22", end: "2026-06-26", status: "PENDING" },
];

// ── 9. Performance review statuses (cycle through) ────────────────────────────
const REVIEW_STATUSES = ["FINALIZED", "IN_PROGRESS", "DRAFT"];

async function main() {
  console.log(`Seeding HR dev dataset for tenant ${TENANT} ...`);

  // 1. Departments
  const deptByName = {};
  for (const name of DEPARTMENTS) {
    deptByName[name] = await getOrCreate(
      "businessUnit",
      { name, tenantId: TENANT },
      { name, description: `${name} department`, tenantId: TENANT }
    );
  }

  // 2. Grades
  const gradeByName = {};
  for (const g of GRADES) {
    gradeByName[g.name] = await getOrCreate(
      "gradeLevel",
      { name: g.name, tenantId: TENANT },
      { name: g.name, description: g.description, tenantId: TENANT }
    );
  }

  // 3. Positions (jobCode NOT db-unique → upsertBy find/update/create)
  const posByCode = {};
  for (const p of POSITIONS) {
    posByCode[p.jobCode] = await upsertBy(
      "position",
      { jobCode: p.jobCode },
      { jobCode: p.jobCode, title: p.title, isActive: true, tenantId: TENANT },
      { title: p.title, isActive: true, tenantId: TENANT }
    );
  }

  // 4. Employees — two passes so managerId can reference seeded rows.
  const empByCode = {};
  for (const e of EMPLOYEES) {
    const pos = posByCode[e.job];
    const existing = await prisma.employee.findFirst({
      where: { employee_code: e.code, tenant_id: TENANT },
    });
    const data = {
      tenant_id: TENANT,
      first_name: e.first,
      last_name: e.last,
      employee_name: `${e.first} ${e.last}`,
      employee_code: e.code,
      email: `${e.first}.${e.last}@trusoft.dev`.toLowerCase(),
      work_email: `${e.first}.${e.last}@trusoft.dev`.toLowerCase(),
      job_title: pos.title,
      employee_type: "permanent",
      employement_status: "Active",
      status: "Active",
      gender: "Unspecified",
      joining_date: d(e.joined),
      hire_date: d(e.joined),
      tenureMonths: String(monthsBetween(d(e.joined), NOW)),
      fte: 1.0,
      positionId: pos.id,
      businessUnitId: deptByName[e.dept].id,
      gradeLevelId: gradeByName[e.grade].id,
    };
    empByCode[e.code] = existing
      ? await prisma.employee.update({ where: { id: existing.id }, data })
      : await prisma.employee.create({ data });
  }
  // manager pass
  for (const e of EMPLOYEES) {
    if (!e.mgr) continue;
    await prisma.employee.update({
      where: { id: empByCode[e.code].id },
      data: { managerId: empByCode[e.mgr].id, reportToId: empByCode[e.mgr].id },
    });
  }

  const hrManager = empByCode["DEV-007"]; // policy / request author
  const financeManager = empByCode["DEV-015"]; // run approver

  // 5. Leave policies (name unique → upsert; createdById required)
  const policyByName = {};
  for (const lp of LEAVE_POLICIES) {
    policyByName[lp.name] = await prisma.leavePolicy.upsert({
      where: { name: lp.name },
      update: { tenantId: TENANT },
      create: {
        name: lp.name,
        description: `${lp.name} policy`,
        leaveTypeCode: lp.leaveTypeCode,
        accrualRate: lp.accrualRate,
        accrualPeriod: lp.accrualPeriod,
        carryForwardAllowed: lp.leaveTypeCode === "AL",
        maxCarryForward: lp.leaveTypeCode === "AL" ? 10 : 0,
        active: true,
        createdById: hrManager.id,
        tenantId: TENANT,
      },
    });
  }

  // 6. Requisitions (unique title → findFirst/create)
  const reqByTitle = {};
  for (const r of REQUISITIONS) {
    reqByTitle[r.title] = await getOrCreate(
      "jobRequisition",
      { title: r.title, tenantId: TENANT },
      {
        title: r.title,
        description: `${r.title} opening`,
        departmentId: deptByName[r.dept].id,
        positionId: posByCode[r.job].id,
        requestedById: empByCode[r.reqBy].id,
        approvedById: r.approvedBy ? empByCode[r.approvedBy].id : null,
        openings: r.openings,
        status: r.status,
        tenantId: TENANT,
      }
    );
  }

  // 7. Candidates (email unique → upsert) + Application (compound unique → upsert)
  for (const c of CANDIDATES) {
    const candidate = await prisma.candidate.upsert({
      where: { email: c.email },
      update: { tenantId: TENANT, status: "active" },
      create: {
        firstName: c.first,
        lastName: c.last,
        email: c.email,
        source: c.source,
        status: "active",
        tenantId: TENANT,
      },
    });
    const req = reqByTitle[c.req];
    await prisma.application.upsert({
      where: {
        candidateId_jobRequisitionId: {
          candidateId: candidate.id,
          jobRequisitionId: req.id,
        },
      },
      update: { stage: c.stage, status: c.appStatus, tenantId: TENANT },
      create: {
        candidateId: candidate.id,
        jobRequisitionId: req.id,
        stage: c.stage,
        status: c.appStatus,
        tenantId: TENANT,
      },
    });
  }

  // 8. Leave requests (findFirst on emp+policy+start → create)
  for (const lr of LEAVE_REQUESTS) {
    const emp = empByCode[lr.emp];
    const policy = policyByName[lr.policy];
    const existing = await prisma.leaveRequest.findFirst({
      where: { employeeId: emp.id, leavePolicyId: policy.id, startDate: d(lr.start), tenantId: TENANT },
    });
    if (existing) continue;
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leavePolicyId: policy.id,
        startDate: d(lr.start),
        endDate: d(lr.end),
        totalDays: dayspan(lr.start, lr.end),
        reason: `${lr.policy} request`,
        status: lr.status,
        createdById: emp.id,
        tenantId: TENANT,
      },
    });
  }

  // 9. Payroll run (compound unique [tenantId, periodStart, periodEnd]) + payslips
  const periodStart = d("2026-05-01");
  const periodEnd = d("2026-05-31");
  let run = await prisma.payrollRun.findFirst({
    where: { tenantId: TENANT, periodStart, periodEnd },
  });
  // Pre-compute totals from the per-employee gross/deduction model.
  let totalGross = 0;
  let totalDeductions = 0;
  const payslipPlan = EMPLOYEES.map((e) => {
    const gross = GROSS_BY_GRADE[e.grade];
    const deductions = Math.round(gross * 0.12); // tax + statutory ~ 12%
    const net = gross - deductions;
    totalGross += gross;
    totalDeductions += deductions;
    return { code: e.code, gross, deductions, net };
  });
  const totalNet = totalGross - totalDeductions;

  if (!run) {
    run = await prisma.payrollRun.create({
      data: {
        tenantId: TENANT,
        periodStart,
        periodEnd,
        countryCode: "PK",
        currencyCode: "PKR",
        status: "FINALIZED",
        totalGross,
        totalDeductions,
        totalNet,
        employeeCount: payslipPlan.length,
        processedBy: hrManager.id,
        approvedBy: financeManager.id, // distinct approver (no self-approval)
        approvedAt: d("2026-06-01"),
        processedAt: d("2026-05-31"),
        ruleVersion: "2026.05",
        ratesEffectiveAt: d("2026-05-01"),
      },
    });
  }

  // A second, in-flight run so the runs list shows >1 status.
  const junStart = d("2026-06-01");
  const junEnd = d("2026-06-30");
  await getOrCreate(
    "payrollRun",
    { tenantId: TENANT, periodStart: junStart, periodEnd: junEnd },
    {
      tenantId: TENANT,
      periodStart: junStart,
      periodEnd: junEnd,
      countryCode: "PK",
      currencyCode: "PKR",
      status: "PROCESSING",
      employeeCount: payslipPlan.length,
      processedBy: hrManager.id,
      ruleVersion: "2026.06",
      ratesEffectiveAt: junStart,
    }
  );

  // Payslips: one per employee for the May run; net = gross - deductions.
  for (const p of payslipPlan) {
    const emp = empByCode[p.code];
    await prisma.payrollPayslip.upsert({
      where: { payrollRunId_employeeId: { payrollRunId: run.id, employeeId: emp.id } },
      update: {
        grossAmount: p.gross,
        totalDeductions: p.deductions,
        netAmount: p.net,
        status: "DISTRIBUTED",
        tenantId: TENANT,
      },
      create: {
        tenantId: TENANT,
        payrollRunId: run.id,
        employeeId: emp.id,
        grossAmount: p.gross,
        totalDeductions: p.deductions,
        netAmount: p.net,
        status: "DISTRIBUTED",
        distributedAt: d("2026-06-02"),
        ruleVersion: "2026.05",
      },
    });
  }

  // 10. Performance cycle (findFirst on name) + reviews for non-managers
  const cycle = await getOrCreate(
    "performanceCycle",
    { name: "H1 2026 Review", tenantId: TENANT },
    {
      name: "H1 2026 Review",
      description: "First-half 2026 performance review cycle",
      start_date: d("2026-01-01"),
      end_date: d("2026-06-30"),
      status: "ACTIVE",
      tenantId: TENANT,
    }
  );

  let ri = 0;
  for (const e of EMPLOYEES) {
    if (!e.mgr) continue; // managers reviewed elsewhere; reviewers are managers
    const emp = empByCode[e.code];
    const reviewer = empByCode[e.mgr];
    const existing = await prisma.performanceReview.findFirst({
      where: { employeeId: emp.id, cycleId: cycle.id, tenantId: TENANT },
    });
    if (existing) {
      ri += 1;
      continue;
    }
    const status = REVIEW_STATUSES[ri % REVIEW_STATUSES.length];
    const rating = Math.round((3.2 + (ri % 9) * 0.18) * 10) / 10; // 3.2 .. 4.6
    await prisma.performanceReview.create({
      data: {
        employeeId: emp.id,
        reviewerId: reviewer.id,
        cycleId: cycle.id,
        period_start: d("2026-01-01"),
        period_end: d("2026-06-30"),
        overall_rating: status === "DRAFT" ? null : rating,
        comments: status === "DRAFT" ? null : `H1 2026 performance review for ${emp.employee_name}`,
        submittedAt: status === "FINALIZED" ? d("2026-06-20") : null,
        status,
        type: "MANAGER",
        tenantId: TENANT,
      },
    });
    ri += 1;
  }

  // 11. Attendance — BLOCKER-2: ~50 coherent rows (25 employees × 2 recent
  // business days) for the dev tenant so the hr_attendance_list screen renders
  // real, tenant-scoped data instead of null-tenant junk. Statuses cover
  // present/late/absent; present/late carry sensible check-in/out + hours.
  // Idempotent: keyed on (employeeId, tenantId, exact date) → re-runs add none.
  // Cover the last several days INCLUDING the current date (2026-06-28) so the
  // attendance tool — which defaults its window to "today" (new Date()) — renders
  // populated by default instead of empty. (Was Jun 25/26 only → empty on Jun 28.)
  const ATTENDANCE_DATES = ["2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const at = (dateStr, h, m) => new Date(`${dateStr}T${pad2(h)}:${pad2(m)}:00.000Z`);
  let attCreated = 0;
  for (let j = 0; j < ATTENDANCE_DATES.length; j += 1) {
    const dateStr = ATTENDANCE_DATES[j];
    const dateAtMidnight = d(dateStr);
    let i = 0;
    for (const e of EMPLOYEES) {
      const emp = empByCode[e.code];
      const seq = i + j;

      let status;
      let check_in = null;
      let check_out = null;
      let total_hours = null;
      let remarks = null;

      if (seq % 11 === 0) {
        status = "ABSENT";
        remarks = "No punch recorded";
      } else if (seq % 4 === 1) {
        status = "LATE";
        check_in = at(dateStr, 9, 30 + (i % 20)); // after 09:15 grace
        check_out = at(dateStr, 18, i % 30);
        total_hours = Math.round(((check_out - check_in) / 3_600_000) * 100) / 100;
        remarks = "Late arrival";
      } else {
        status = "PRESENT";
        check_in = at(dateStr, 9, i % 12); // 09:00–09:11, within grace
        check_out = at(dateStr, 17, 30 + (i % 20));
        total_hours = Math.round(((check_out - check_in) / 3_600_000) * 100) / 100;
      }

      const existing = await prisma.attendance.findFirst({
        where: { employeeId: emp.id, tenantId: TENANT, date: dateAtMidnight },
      });
      if (!existing) {
        await prisma.attendance.create({
          data: {
            employeeId: emp.id,
            tenantId: TENANT,
            date: dateAtMidnight,
            check_in,
            check_out,
            total_hours,
            status,
            remarks,
          },
        });
        attCreated += 1;
      }
      i += 1;
    }
  }
  console.log(`Attendance: ${attCreated} new rows (target ~${EMPLOYEES.length * ATTENDANCE_DATES.length}).`);

  console.log("HR dev seed complete.");
}

mcpCtx.run({ user: { tenantId: TENANT }, permissions: {} }, () => main())
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error("HR dev seed failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
