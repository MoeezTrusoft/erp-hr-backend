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
import { deriveAttendanceStatus, resolveShiftStartMin } from "../src/lib/attendanceStatus.js"; // seed status must agree with the app write-path

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

  // 11b. Current-month attendance (July 2026) — a realistic month-to-date grid
  // for ~10 employees across working days (Mon–Sat) so the current-month
  // attendance / timesheet screens render live, coherent data. Status is derived
  // by the SAME shared helper the app write-path uses (deriveAttendanceStatus +
  // resolveShiftStartMin), so seed and app agree. Idempotent: keyed on
  // (employeeId, exact date) → re-runs add none. No tenantId passed — the ambient
  // RLS create-net default stamps it.
  const monthEmployees = await prisma.employee.findMany({ take: 10 });
  const monthBase = new Date("2026-07-01");
  const monthEnd = new Date("2026-07-24"); // month-to-date
  const isoDate = (dt) =>
    `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  // Normalize minute overflow into the hour (callers pass e.g. m=60/75 for
  // 10:00 / 10:15) so we never build an invalid "HH:60" clock string.
  const atUtc = (dateStr, h, m) => {
    const hh = h + Math.floor(m / 60);
    const mm = m % 60;
    return new Date(`${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`);
  };

  // Work days: Mon–Sat (skip Sunday, getUTCDay() === 0).
  const workDays = [];
  for (let dt = new Date(monthBase); dt <= monthEnd; dt = new Date(dt.getTime() + 86_400_000)) {
    if (dt.getUTCDay() !== 0) workDays.push(isoDate(dt));
  }

  // Deterministic mix: mostly PRESENT (on-time), a scatter of LATE, HALF_DAY,
  // ABSENT, plus a few missing check-outs. Work-mode mostly Onsite with some
  // Remote/Hybrid. Keyed off (employee index, day index) so it's stable.
  const WORK_MODES = ["Onsite", "Onsite", "Onsite", "Remote", "Hybrid"];
  const monthBuckets = { PRESENT: 0, LATE: 0, HALF_DAY: 0, ABSENT: 0 };
  let monthAttCreated = 0;
  for (let di = 0; di < workDays.length; di += 1) {
    const dateStr = workDays[di];
    const dateAtMidnight = d(dateStr);
    const shiftStartMin = resolveShiftStartMin({ date: dateAtMidnight });
    for (let ei = 0; ei < monthEmployees.length; ei += 1) {
      const emp = monthEmployees[ei];
      const seq = ei * 3 + di; // spread the pattern across the grid

      let check_in = null;
      let check_out = null;
      let total_hours = null;
      let remarks = null;
      const work_mode = WORK_MODES[(ei + di) % WORK_MODES.length];

      if (seq % 13 === 5) {
        // ABSENT — no punch.
        remarks = "No punch recorded";
      } else if (seq % 11 === 4) {
        // HALF_DAY — arrives 09:45–10:30 (≥30min late).
        check_in = atUtc(dateStr, 9, 45 + (seq % 3) * 15); // 09:45 / 10:00 / 10:15
        // half-days leave early; a couple have no check-out ("-").
        if (seq % 2 === 0) {
          check_out = atUtc(dateStr, 14, seq % 30);
          total_hours = Math.round(((check_out - check_in) / 3_600_000) * 100) / 100;
        }
        remarks = "Half day";
      } else if (seq % 5 === 2) {
        // LATE — arrives 09:10–09:25.
        check_in = atUtc(dateStr, 9, 10 + (seq % 4) * 5); // 09:10..09:25
        check_out = atUtc(dateStr, 17, 30 + (seq % 20));
        total_hours = Math.round(((check_out - check_in) / 3_600_000) * 100) / 100;
        remarks = "Late arrival";
      } else {
        // PRESENT — on-time, 08:55–09:00.
        check_in = atUtc(dateStr, seq % 2 === 0 ? 8 : 9, seq % 2 === 0 ? 55 + (seq % 5) : seq % 1);
        // leave check_out null on a few present days to exercise the "-" case.
        if (seq % 7 !== 3) {
          check_out = atUtc(dateStr, 17, (seq % 60));
          total_hours = Math.round(((check_out - check_in) / 3_600_000) * 100) / 100;
        }
      }

      // Status derived by the shared helper so seed == app write-path.
      const status = deriveAttendanceStatus(check_in, shiftStartMin);
      monthBuckets[status] += 1;

      const existing = await prisma.attendance.findFirst({
        where: { employeeId: emp.id, date: dateAtMidnight },
      });
      if (existing) continue;
      await prisma.attendance.create({
        data: {
          employeeId: emp.id,
          date: dateAtMidnight,
          check_in,
          check_out,
          total_hours,
          status,
          work_mode: status === "ABSENT" ? null : work_mode,
          remarks,
        },
      });
      monthAttCreated += 1;
    }
  }
  console.log(
    `July-2026 attendance: +${monthAttCreated} rows across ${workDays.length} work days ` +
      `(PRESENT ${monthBuckets.PRESENT}, LATE ${monthBuckets.LATE}, HALF_DAY ${monthBuckets.HALF_DAY}, ABSENT ${monthBuckets.ABSENT}).`
  );

  // 11c. Attendance anomalies (~6) — "Inform Abnormality" requests feeding the
  // Timesheet pending-approvals list + Leave & Anomaly screen. Mostly PENDING,
  // a couple decided. Idempotent: keyed on (employeeId, type, date). No tenantId
  // passed — ambient RLS default stamps it.
  const ANOMALIES = [
    { empIdx: 0, type: "LATE_CHECKIN", date: "2026-07-03", from: [9, 30], to: [9, 45], status: "PENDING", reason: "Traffic on the ring road; requesting late-mark waiver." },
    { empIdx: 1, type: "MISSING_CHECKOUT", date: "2026-07-07", from: [17, 30], to: [18, 30], status: "PENDING", reason: "Forgot to punch out after client call." },
    { empIdx: 2, type: "ABSENT", date: "2026-07-09", from: null, to: null, status: "PENDING", reason: "Was on approved field visit; attendance not recorded." },
    { empIdx: 3, type: "OTHER", date: "2026-07-11", from: [9, 0], to: [13, 0], status: "PENDING", reason: "Worked from partner office; device did not capture punch.", detail: "Off-site at partner premises" },
    { empIdx: 4, type: "LATE_CHECKIN", date: "2026-07-02", from: [9, 20], to: [9, 30], status: "APPROVED", reason: "Medical appointment in the morning.", decided: true },
    { empIdx: 5, type: "MISSING_CHECKOUT", date: "2026-07-04", from: [18, 0], to: [19, 0], status: "REJECTED", reason: "No prior approval for overtime stay.", decided: true },
  ];
  const anomToTime = (dateStr, hm) => (hm ? atUtc(dateStr, hm[0], hm[1]) : null);
  const anomBuckets = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  let anomCreated = 0;
  for (const a of ANOMALIES) {
    const emp = monthEmployees[a.empIdx % monthEmployees.length];
    const dateAtMidnight = d(a.date);
    anomBuckets[a.status] += 1;
    const existing = await prisma.attendanceAnomaly.findFirst({
      where: { employeeId: emp.id, type: a.type, date: dateAtMidnight },
    });
    if (existing) continue;
    await prisma.attendanceAnomaly.create({
      data: {
        employeeId: emp.id,
        type: a.type,
        reason: a.reason,
        detail: a.detail ?? null,
        date: dateAtMidnight,
        fromTime: anomToTime(a.date, a.from),
        toTime: anomToTime(a.date, a.to),
        status: a.status,
        reviewerId: a.decided ? hrManager.id : null,
        reviewNote: a.decided ? (a.status === "APPROVED" ? "Approved — supporting reason accepted." : "Rejected — no prior approval.") : null,
        decidedAt: a.decided ? atUtc(a.date, 12, 0) : null,
      },
    });
    anomCreated += 1;
  }
  console.log(
    `Attendance anomalies: +${anomCreated} (PENDING ${anomBuckets.PENDING}, APPROVED ${anomBuckets.APPROVED}, REJECTED ${anomBuckets.REJECTED}).`
  );

  // 11d. Overtime requests (~4, all PENDING) — feeds the pending-approvals feed
  // with overtime items. July 2026, hours 1–4. Idempotent: keyed on
  // (employeeId, date, reason). No tenantId passed — ambient RLS default stamps.
  const OVERTIME = [
    { empIdx: 0, date: "2026-07-08", hours: 2, from: "18:00", to: "20:00", reason: "Production release window support." },
    { empIdx: 2, date: "2026-07-10", hours: 3, from: "18:30", to: "21:30", reason: "Sprint deadline — feature completion." },
    { empIdx: 5, date: "2026-07-15", hours: 1.5, from: "17:30", to: "19:00", reason: "Month-end reconciliation." },
    { empIdx: 7, date: "2026-07-18", hours: 4, from: "17:00", to: "21:00", reason: "Client demo preparation." },
  ];
  let otCreated = 0;
  for (const o of OVERTIME) {
    const emp = monthEmployees[o.empIdx % monthEmployees.length];
    const dateAtMidnight = d(o.date);
    const existing = await prisma.overtimeRequest.findFirst({
      where: { employeeId: emp.id, date: dateAtMidnight, reason: o.reason },
    });
    if (existing) continue;
    await prisma.overtimeRequest.create({
      data: {
        employeeId: emp.id,
        date: dateAtMidnight,
        hours: o.hours,
        rate: 1.5,
        fromTime: o.from,
        toTime: o.to,
        reason: o.reason,
        status: "PENDING",
      },
    });
    otCreated += 1;
  }
  console.log(`Overtime requests: +${otCreated} (all PENDING).`);

  // 12. Course Catalog + Certifications (LMS) — coherent data so the Course
  // Catalog, Course View, Transcripts and Certifications screens render real
  // rows. New-model tenantId is stamped by the RLS extension / column DEFAULT
  // hr_current_tenant() under the ambient tenant context, so seed creates do NOT
  // pass tenantId. Parent rows are created first, then children reference the
  // returned id sequentially (no nested create) so each row's GUC/default
  // applies cleanly. Idempotent-ish: guarded on the course courseCode.
  const CERT_BASE = new Date("2026-07-23T00:00:00.000Z");
  const plusDays = (base, n) => new Date(base.getTime() + n * 86_400_000);

  // Reuse a handful of real employees as authors / instructors / enrollees /
  // reviewers / certification owners.
  const lmsEmps = await prisma.employee.findMany({ take: 8 });

  // Training categories (name is not db-unique → getOrCreate find/create).
  const CATEGORY_NAMES = ["Web Development", "Data & AI", "Compliance"];
  const catByName = {};
  for (const name of CATEGORY_NAMES) {
    catByName[name] = await getOrCreate(
      "trainingCategory",
      { name },
      { name, description: `${name} courses` }
    );
  }

  // Full course specs — each with sections/lectures/outcomes/reviews.
  const COURSES = [
    {
      courseCode: "WD-101",
      title: "Complete Web Development Bootcamp",
      subtitle: "Go from zero to full-stack developer",
      category: "Web Development",
      mode: "ONLINE",
      durationHours: 40,
      tags: ["html", "css", "javascript", "react"],
      relatedTopics: ["JavaScript", "React", "Node.js"],
      requirements: ["A computer with internet", "No prior experience needed"],
      description:
        "A hands-on bootcamp covering HTML, CSS, JavaScript, React and Node.js to build and ship real web applications.",
      sections: [
        {
          title: "Getting Started with the Web",
          lectures: [
            { title: "Welcome & Course Overview", dur: 420 },
            { title: "How the Web Works", dur: 780 },
            { title: "Setting Up Your Editor", dur: 540 },
            { title: "Your First HTML Page", dur: 900 },
          ],
        },
        {
          title: "Styling with CSS",
          lectures: [
            { title: "CSS Fundamentals", dur: 660 },
            { title: "The Box Model", dur: 720 },
            { title: "Flexbox & Grid", dur: 1080 },
            { title: "Responsive Design", dur: 960 },
            { title: "CSS Project: Landing Page", dur: 1200 },
          ],
        },
        {
          title: "JavaScript & React",
          lectures: [
            { title: "JavaScript Basics", dur: 840 },
            { title: "DOM Manipulation", dur: 720 },
            { title: "Intro to React", dur: 1020 },
            { title: "React Hooks", dur: 1140 },
            { title: "Building a React App", dur: 1200 },
            { title: "Deploying Your App", dur: 600 },
          ],
        },
      ],
      outcomes: [
        { title: "Build responsive websites", description: "Structure and style pages that work on any device." },
        { title: "Write modern JavaScript", description: "Use ES modules, promises and async/await confidently." },
        { title: "Create React applications", description: "Compose components and manage state with hooks." },
        { title: "Deploy to production", description: "Ship a full-stack app to a live URL." },
      ],
      reviews: [
        { rating: 5, comment: "Best bootcamp I've taken — clear and practical." },
        { rating: 4, comment: "Great pacing, wish there was more on testing." },
        { rating: 5, comment: "The React section alone was worth it." },
        { rating: 4, comment: "Solid fundamentals, hands-on projects helped." },
        { rating: 5, comment: "Highly recommend for beginners." },
      ],
    },
    {
      courseCode: "DS-201",
      title: "Data Science & Machine Learning",
      subtitle: "From data wrangling to predictive models",
      category: "Data & AI",
      mode: "HYBRID",
      durationHours: 60,
      tags: ["python", "pandas", "machine-learning", "statistics"],
      relatedTopics: ["Python", "Pandas", "scikit-learn"],
      requirements: ["Basic Python knowledge", "High-school level math"],
      description:
        "Learn to clean and analyze data, visualize insights, and train machine-learning models with Python.",
      sections: [
        {
          title: "Foundations of Data Science",
          lectures: [
            { title: "What is Data Science?", dur: 480 },
            { title: "Python for Data", dur: 900 },
            { title: "NumPy Essentials", dur: 780 },
            { title: "Pandas DataFrames", dur: 1020 },
          ],
        },
        {
          title: "Exploratory Analysis",
          lectures: [
            { title: "Data Cleaning", dur: 840 },
            { title: "Descriptive Statistics", dur: 720 },
            { title: "Data Visualization", dur: 960 },
            { title: "Feature Engineering", dur: 1080 },
          ],
        },
        {
          title: "Machine Learning",
          lectures: [
            { title: "Supervised Learning", dur: 1140 },
            { title: "Regression Models", dur: 1020 },
            { title: "Classification Models", dur: 1080 },
            { title: "Model Evaluation", dur: 900 },
          ],
        },
      ],
      outcomes: [
        { title: "Wrangle real datasets", description: "Clean, merge and reshape data with Pandas." },
        { title: "Visualize insights", description: "Communicate findings with clear charts." },
        { title: "Train ML models", description: "Build and evaluate regression and classification models." },
        { title: "Avoid common pitfalls", description: "Recognize overfitting and data leakage." },
      ],
      reviews: [
        { rating: 5, comment: "Deep and practical, great real-world datasets." },
        { rating: 4, comment: "Challenging but rewarding." },
        { rating: 4, comment: "Loved the ML evaluation module." },
      ],
    },
    {
      courseCode: "CMP-100",
      title: "Workplace Safety & Compliance",
      subtitle: "Stay compliant and keep your team safe",
      category: "Compliance",
      mode: "OFFLINE",
      durationHours: 8,
      tags: ["safety", "compliance", "policy"],
      relatedTopics: ["Occupational Safety", "Data Privacy", "Ethics"],
      requirements: ["No prerequisites"],
      description:
        "Mandatory training on workplace safety procedures, data privacy and the company code of conduct.",
      sections: [
        {
          title: "Health & Safety",
          lectures: [
            { title: "Emergency Procedures", dur: 600 },
            { title: "Ergonomics at Work", dur: 480 },
            { title: "Incident Reporting", dur: 540 },
            { title: "Fire Safety", dur: 420 },
          ],
        },
        {
          title: "Data & Conduct",
          lectures: [
            { title: "Data Privacy Basics", dur: 660 },
            { title: "Handling Sensitive Data", dur: 720 },
            { title: "Code of Conduct", dur: 540 },
            { title: "Reporting Violations", dur: 480 },
          ],
        },
        {
          title: "Assessment",
          lectures: [
            { title: "Compliance Scenarios", dur: 600 },
            { title: "Final Knowledge Check", dur: 300 },
            { title: "Certification Steps", dur: 360 },
            { title: "Wrap-up & Resources", dur: 300 },
          ],
        },
      ],
      outcomes: [
        { title: "Respond to emergencies", description: "Follow correct emergency and evacuation procedures." },
        { title: "Protect sensitive data", description: "Apply data-privacy rules to daily work." },
        { title: "Uphold the code of conduct", description: "Recognize and report policy violations." },
        { title: "Pass the compliance check", description: "Meet the mandatory annual requirement." },
      ],
      reviews: [
        { rating: 4, comment: "Clear and to the point." },
        { rating: 3, comment: "Necessary, if a bit dry." },
        { rating: 5, comment: "The scenarios made it stick." },
        { rating: 4, comment: "Good refresher on data privacy." },
      ],
    },
  ];

  let lmsCourses = 0;
  let lmsSections = 0;
  let lmsLectures = 0;
  let lmsOutcomes = 0;
  let lmsReviews = 0;
  const courseByCode = {};

  for (const c of COURSES) {
    // Guard: skip the whole block if this course already exists.
    const already = await prisma.trainingCourse.findFirst({ where: { courseCode: c.courseCode } });
    if (already) {
      courseByCode[c.courseCode] = already;
      continue;
    }

    const author = lmsEmps[lmsCourses % lmsEmps.length];
    const instructor = lmsEmps[(lmsCourses + 1) % lmsEmps.length];
    const course = await prisma.trainingCourse.create({
      data: {
        title: c.title,
        subtitle: c.subtitle,
        description: c.description,
        courseCode: c.courseCode,
        language: "English",
        mode: c.mode,
        durationHours: c.durationHours,
        tags: c.tags,
        relatedTopics: c.relatedTopics,
        requirements: c.requirements,
        introVideoMediaId: 1001 + lmsCourses,
        createdById: author.id,
        instructorId: instructor.id,
        status: "ACTIVE",
        categoryId: catByName[c.category].id,
      },
    });
    courseByCode[c.courseCode] = course;
    lmsCourses += 1;

    // Sections + their lectures (sequential; first lecture of first section is preview).
    let sIdx = 0;
    for (const s of c.sections) {
      const section = await prisma.courseSection.create({
        data: { courseId: course.id, title: s.title, sortOrder: sIdx },
      });
      lmsSections += 1;
      let lIdx = 0;
      for (const lec of s.lectures) {
        await prisma.courseLecture.create({
          data: {
            sectionId: section.id,
            title: lec.title,
            videoMediaId: 2001 + lmsLectures,
            durationSeconds: lec.dur,
            sortOrder: lIdx,
            isPreview: sIdx === 0 && lIdx === 0,
          },
        });
        lmsLectures += 1;
        lIdx += 1;
      }
      sIdx += 1;
    }

    // Outcomes.
    let oIdx = 0;
    for (const o of c.outcomes) {
      await prisma.courseOutcome.create({
        data: { courseId: course.id, title: o.title, description: o.description, sortOrder: oIdx },
      });
      lmsOutcomes += 1;
      oIdx += 1;
    }

    // Reviews from different employees.
    let rIdx = 0;
    for (const rv of c.reviews) {
      const reviewer = lmsEmps[(lmsCourses + rIdx) % lmsEmps.length];
      await prisma.courseReview.create({
        data: { courseId: course.id, employeeId: reviewer.id, rating: rv.rating, comment: rv.comment },
      });
      lmsReviews += 1;
      rIdx += 1;
    }

    // Denormalize rating avg/count from the reviews just created.
    const ratings = c.reviews.map((r) => r.rating);
    const ratingCount = ratings.length;
    const ratingAvg = Math.round((ratings.reduce((a, b) => a + b, 0) / ratingCount) * 100) / 100;
    await prisma.trainingCourse.update({
      where: { id: course.id },
      data: { ratingAvg, ratingCount },
    });
  }
  console.log(
    `LMS courses: +${lmsCourses} (sections ${lmsSections}, lectures ${lmsLectures}, outcomes ${lmsOutcomes}, reviews ${lmsReviews}).`
  );

  // Enrollments — mix of statuses so the transcript screen has data. Keyed on
  // (courseId, employeeId) via findFirst → idempotent.
  const ENROLLMENTS = [
    { code: "WD-101", empIdx: 0, status: "COMPLETED", progress: 100, completed: 30, score: 92 },
    { code: "WD-101", empIdx: 1, status: "IN_PROGRESS", progress: 55 },
    { code: "WD-101", empIdx: 2, status: "ENROLLED", progress: 0 },
    { code: "DS-201", empIdx: 3, status: "COMPLETED", progress: 100, completed: 45, score: 88 },
    { code: "DS-201", empIdx: 4, status: "IN_PROGRESS", progress: 40 },
    { code: "CMP-100", empIdx: 0, status: "COMPLETED", progress: 100, completed: 15, score: 95 },
    { code: "CMP-100", empIdx: 5, status: "COMPLETED", progress: 100, completed: 20, score: 78 },
    { code: "CMP-100", empIdx: 6, status: "ENROLLED", progress: 0 },
  ];
  let lmsEnrollments = 0;
  for (const en of ENROLLMENTS) {
    const course = courseByCode[en.code];
    const emp = lmsEmps[en.empIdx % lmsEmps.length];
    const existing = await prisma.trainingEnrollment.findFirst({
      where: { courseId: course.id, employeeId: emp.id },
    });
    if (existing) continue;
    await prisma.trainingEnrollment.create({
      data: {
        courseId: course.id,
        employeeId: emp.id,
        status: en.status,
        progress: en.progress,
        completionDate: en.status === "COMPLETED" ? plusDays(CERT_BASE, -(en.completed || 30)) : null,
        score: en.status === "COMPLETED" ? en.score ?? null : null,
      },
    });
    lmsEnrollments += 1;
  }
  console.log(`LMS enrollments: +${lmsEnrollments}.`);

  // Certifications — spread across ALL KPI buckets. Keyed on (employeeId, name)
  // via findFirst → idempotent. Owners cycle through the reused employees.
  const CERTIFICATIONS = [
    // ACTIVE (3–4): expiry well in the future or null.
    { empIdx: 0, name: "AWS Certified Solutions Architect", category: "Technical", status: "ACTIVE", issuedBy: "Amazon Web Services", issued: -400, expiry: 330, course: "WD-101" },
    { empIdx: 1, name: "Certified Kubernetes Administrator", category: "Technical", status: "ACTIVE", issuedBy: "CNCF", issued: -200, expiry: 500 },
    { empIdx: 2, name: "Professional Scrum Master", category: "Technical", status: "ACTIVE", issuedBy: "Scrum.org", issued: -120, expiry: null },
    { empIdx: 3, name: "ISO 9001 Auditor", category: "Compliance", status: "ACTIVE", issuedBy: "ISO", issued: -300, expiry: 400 },
    // RENEWAL / expiring soon (1–2): expiryDate within ~45 days of base.
    { empIdx: 4, name: "First Aid Certification", category: "Safety", status: "RENEWAL", issuedBy: "Red Crescent", issued: -700, expiry: 30, course: "CMP-100" },
    { empIdx: 5, name: "OSHA Safety Certification", category: "Safety", status: "ACTIVE", issuedBy: "OSHA", issued: -350, expiry: 20 },
    // INACTIVE (1).
    { empIdx: 6, name: "Legacy PCI-DSS Assessor", category: "Compliance", status: "INACTIVE", issuedBy: "PCI SSC", issued: -900, expiry: -60 },
    // EXPIRED (1–2): expiryDate in the past.
    { empIdx: 7, name: "Google Analytics Certification", category: "Technical", status: "EXPIRED", issuedBy: "Google", issued: -800, expiry: -120 },
    { empIdx: 0, name: "GDPR Data Protection Certification", category: "Compliance", status: "EXPIRED", issuedBy: "IAPP", issued: -750, expiry: -30 },
  ];
  let lmsCerts = 0;
  const certBuckets = { ACTIVE: 0, RENEWAL: 0, INACTIVE: 0, EXPIRED: 0 };
  for (const ct of CERTIFICATIONS) {
    const emp = lmsEmps[ct.empIdx % lmsEmps.length];
    const existing = await prisma.certification.findFirst({
      where: { employeeId: emp.id, name: ct.name },
    });
    if (existing) {
      certBuckets[ct.status] += 1;
      continue;
    }
    await prisma.certification.create({
      data: {
        employeeId: emp.id,
        courseId: ct.course ? courseByCode[ct.course]?.id ?? null : null,
        name: ct.name,
        category: ct.category,
        status: ct.status,
        issuedBy: ct.issuedBy,
        issuedAt: plusDays(CERT_BASE, ct.issued),
        expiryDate: ct.expiry === null ? null : plusDays(CERT_BASE, ct.expiry),
      },
    });
    lmsCerts += 1;
    certBuckets[ct.status] += 1;
  }
  console.log(
    `LMS certifications: +${lmsCerts} (ACTIVE ${certBuckets.ACTIVE}, RENEWAL ${certBuckets.RENEWAL}, INACTIVE ${certBuckets.INACTIVE}, EXPIRED ${certBuckets.EXPIRED}).`
  );

  // ── 13. Employee documents (EmployeeMedia) with expiry dates ─────────────
  // Feeds the HR Reports → Document Expiry Alerts screen. expiry_date is a
  // STRING (ISO). Dates are relative to 2026-07-23 and span ALL KPI buckets:
  //   2 expired (past), 2 expiring<=30d, 1 expiring<=60d, 1 expiring<=90d,
  //   2 healthy (>90d). Idempotent: keyed on (employee_id, file_name). No
  //   tenantId passed — the ambient RLS create-net default stamps it.
  const DOC_BASE = new Date("2026-07-23T00:00:00.000Z");
  const isoDay = (n) => plusDays(DOC_BASE, n).toISOString();
  const EMPLOYEE_DOCS = [
    // expired (2)
    { empIdx: 0, title: "Passport", file_name: "Passport.pdf", category: "Identity", expiry: -45 },
    { empIdx: 1, title: "Work Visa", file_name: "Work Visa.pdf", category: "Legal", expiry: -10 },
    // expiring within 30d (2)
    { empIdx: 2, title: "Work Permit", file_name: "Work Permit.pdf", category: "Legal", expiry: 12 },
    { empIdx: 3, title: "National ID", file_name: "National ID.pdf", category: "Identity", expiry: 28 },
    // expiring within 60d (1)
    { empIdx: 4, title: "Employment Contract", file_name: "Contract.pdf", category: "Contract", expiry: 50 },
    // expiring within 90d (1)
    { empIdx: 5, title: "Medical Certificate", file_name: "Medical Certificate.pdf", category: "Legal", expiry: 80 },
    // healthy > 90d (2)
    { empIdx: 6, title: "Driving License", file_name: "Driving License.pdf", category: "Identity", expiry: 200 },
    { empIdx: 7, title: "NDA Agreement", file_name: "NDA.pdf", category: "Contract", expiry: 400 },
  ];
  let docsCreated = 0;
  const docBuckets = { expired: 0, expiring30: 0, expiring60: 0, expiring90: 0, healthy: 0 };
  for (const doc of EMPLOYEE_DOCS) {
    const emp = lmsEmps[doc.empIdx % lmsEmps.length];
    if (doc.expiry < 0) docBuckets.expired += 1;
    else if (doc.expiry <= 30) docBuckets.expiring30 += 1;
    else if (doc.expiry <= 60) docBuckets.expiring60 += 1;
    else if (doc.expiry <= 90) docBuckets.expiring90 += 1;
    else docBuckets.healthy += 1;

    const existing = await prisma.employeeMedia.findFirst({
      where: { employee_id: emp.id, file_name: doc.file_name },
    });
    if (existing) continue;
    await prisma.employeeMedia.create({
      data: {
        title: doc.title,
        file_name: doc.file_name,
        category: doc.category,
        mime_type: "application/pdf",
        media_id: 900000 + docsCreated,
        expiry_date: isoDay(doc.expiry),
        uploaded_at: plusDays(DOC_BASE, -365),
        employee_id: emp.id,
        status: "active",
      },
    });
    docsCreated += 1;
  }
  console.log(
    `Employee documents (EmployeeMedia): +${docsCreated} (expired ${docBuckets.expired}, <=30d ${docBuckets.expiring30}, <=60d ${docBuckets.expiring60}, <=90d ${docBuckets.expiring90}, healthy ${docBuckets.healthy}).`
  );

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
