// scripts/seed-prod.mjs — generate a coherent, production-like HR dataset (~75
// employees) across all modules, + one linked RBAC user per employee. Runs in
// the HR pod: HR writes via the C4-extended prisma singleton (encrypts
// salary/bank/ntn); RBAC writes via pg (same `erp` role, db erp-rbac).
//
// Anchored to RBAC Company 2 "Trusoft Technologies" as the tenant. Additive to
// RBAC (creates depts/roles/users; deletes nothing). Assumes HR tables were
// already truncated.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import pg from "pg";
import bcrypt from "bcrypt";

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const sample = (a, k) => { const c = [...a]; const o = []; while (o.length < k && c.length) o.push(c.splice(rnd(c.length), 1)[0]); return o; };
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const round = (n) => Math.round(n);
const round2 = (n) => Math.round(n * 100) / 100;
const atClock = (d, h, m) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0));
const addHours = (d, hrs) => new Date(d.getTime() + Math.round(hrs * 3600) * 1000);
const isWeekday = (d) => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };

const TENANT = "066dd015-2820-47b5-b2fc-1e9704f0f420"; // RBAC Company 2 uuid
const COMPANY_ID = 2;

const FIRST = ["Ahmed","Ali","Hassan","Usman","Bilal","Fahad","Hamza","Zain","Omar","Saad","Kashif","Imran","Faisal","Adnan","Tariq","Raza","Waqas","Noman","Asad","Danish","Ayesha","Fatima","Sana","Hira","Maria","Zainab","Amna","Iqra","Mahnoor","Nimra","Sadia","Rabia","Areeba","Komal","Bushra","Sania"];
const LAST = ["Khan","Ahmed","Malik","Sheikh","Butt","Chaudhry","Raza","Hussain","Iqbal","Farooq","Siddiqui","Qureshi","Abbasi","Zafar","Nawaz","Mirza","Ansari","Baig","Dar","Rana"];
const BU_NAMES = ["Engineering","Sales","Finance","Marketing","Operations","People & Culture"];
const GRADES = [
  { name: "G1 — Associate", base: 85000 },
  { name: "G2 — Executive", base: 130000 },
  { name: "G3 — Senior", base: 200000 },
  { name: "G4 — Lead", base: 300000 },
  { name: "G5 — Manager", base: 450000 },
  { name: "G6 — Director", base: 750000 },
];
const POSITIONS = {
  Engineering: ["Software Engineer","Senior Software Engineer","QA Engineer","DevOps Engineer","Engineering Lead","VP Engineering"],
  Sales: ["Sales Executive","Account Manager","Sales Lead","Sales Director"],
  Finance: ["Accountant","Financial Analyst","Finance Manager","Finance Director"],
  Marketing: ["Marketing Executive","Content Strategist","Marketing Manager"],
  Operations: ["Operations Executive","Operations Analyst","Operations Manager"],
  "People & Culture": ["HR Executive","Recruiter","HR Business Partner","Head of People"],
};
const SKILLS = ["JavaScript","Node.js","React","PostgreSQL","Kubernetes","Docker","Python","TypeScript","AWS","GraphQL","Salesforce","Financial Modeling","Excel","SEO","Copywriting","Data Analysis","Project Management","Recruiting","Payroll","Negotiation"];
const COMPETENCIES = ["Leadership","Communication","Team Collaboration","Problem Solving","Stakeholder Management","Adaptability","Ownership","Mentoring"];
const LEVELS = ["Beginner","Intermediate","Advanced","Expert"];
const scoreToLevel = (s) => (s >= 85 ? "Expert" : s >= 65 ? "Advanced" : s >= 40 ? "Intermediate" : "Beginner");
const CITY_META = {
  Karachi: { province: "Sindh", postal: "74000" },
  Lahore: { province: "Punjab", postal: "54000" },
  Islamabad: { province: "Islamabad Capital Territory", postal: "44000" },
};
const AREAS = ["Gulberg III","DHA Phase 5","Clifton Block 4","Bahria Town","Model Town","F-7 Markaz","Johar Town","North Nazimabad","Askari 10","G-11"];
// Standard employee document set (matches REQUIRED_DOC_TYPES in the profile tabs service).
const DOC_TYPES = [
  { title: "CNIC", category: "CNIC", mime: "image/jpeg", hasExpiry: true },
  { title: "Employment Contract", category: "Employment Contract", mime: "application/pdf", hasExpiry: false },
  { title: "Offer Letter", category: "Offer Letter", mime: "application/pdf", hasExpiry: false },
  { title: "Educational Certificate", category: "Educational Certificate", mime: "application/pdf", hasExpiry: false },
  { title: "Experience Letter", category: "Experience Letter", mime: "application/pdf", hasExpiry: false },
  { title: "Passport", category: "Passport", mime: "image/jpeg", hasExpiry: true },
];
// 13-digit Pakistani CNIC, formatted 00000-0000000-0.
const mkCnic = () => `${String(10000 + rnd(89999))}-${String(1000000 + rnd(8999999))}-${rnd(9)}`;

async function main() {
  const log = (m) => console.log(`[seed] ${m}`);

  // ---------- HR reference data ----------
  const bus = [];
  for (const n of BU_NAMES) bus.push(await prisma.businessUnit.create({ data: { name: n, description: `${n} department`, tenantId: TENANT } }));
  const grades = [];
  for (const g of GRADES) grades.push(await prisma.gradeLevel.create({ data: { name: g.name, description: `Pay grade ${g.name}`, tenantId: TENANT } }));
  const positionsByBu = {};
  for (const bu of bus) {
    positionsByBu[bu.name] = [];
    for (const t of POSITIONS[bu.name]) positionsByBu[bu.name].push(await prisma.position.create({ data: { title: t, isActive: true, tenantId: TENANT } }));
  }
  // Payroll element types
  const earnTypes = {};
  for (const [code, name] of [["BASIC","Basic Salary"],["HRA","House Rent Allowance"],["TA","Transport Allowance"],["MED","Medical Allowance"]])
    earnTypes[code] = await prisma.payrollEarningType.create({ data: { tenantId: TENANT, code: `${code}`, name } });
  const dedTypes = {};
  for (const [code, name] of [["INCOME_TAX","Income Tax"],["EOBI","EOBI"],["PF","Provident Fund"]])
    dedTypes[code] = await prisma.payrollDeductionType.create({ data: { tenantId: TENANT, code: `${code}`, name } });
  // PK FY26 tax brackets (annual)
  const fy26From = new Date("2025-07-01T00:00:00Z");
  for (const [lo, hi, rate] of [[0,600000,0],[600000,1200000,0.05],[1200000,2400000,0.15],[2400000,4800000,0.25],[4800000,null,0.35]])
    await prisma.taxRate.create({ data: { tenantId: TENANT, countryCode: "PK", bracketMin: lo, bracketMax: hi, rate, effectiveFrom: fy26From } });
  // Training
  const trCats = {};
  for (const n of ["Technical","Leadership","Compliance","Sales"]) trCats[n] = await prisma.trainingCategory.create({ data: { name: n, tenantId: TENANT } });
  const courses = [];
  for (const [t, cat] of [["Advanced Node.js","Technical"],["Kubernetes in Production","Technical"],["Leadership Essentials","Leadership"],["Anti-Harassment & Compliance","Compliance"],["Consultative Selling","Sales"],["Financial Acumen","Leadership"],["Secure Coding","Technical"],["Effective Communication","Leadership"]])
    courses.push(await prisma.trainingCourse.create({ data: { title: t, categoryId: trCats[cat].id, durationHours: 4 + rnd(20), mode: pick(["ONLINE","OFFLINE","HYBRID"]), status: "ACTIVE", tenantId: TENANT } }));
  const paths = [];
  for (const n of ["Engineering Onboarding","New Manager Program","Sales Ramp-up"]) paths.push(await prisma.learningPath.create({ data: { name: n, description: `${n} learning path`, status: "PUBLISHED", durationHours: 40, tenantId: TENANT } }));
  // Skills catalog
  const skillRows = {};
  for (const n of SKILLS) skillRows[n] = await prisma.skill.create({ data: { name: n, category: "skill", tenantId: TENANT } });
  for (const n of COMPETENCIES) skillRows[n] = await prisma.skill.create({ data: { name: n, category: "competency", tenantId: TENANT } });
  const cycle = await prisma.performanceCycle.create({ data: { name: "FY26 Annual Review", start_date: fy26From, end_date: new Date("2026-06-30T00:00:00Z"), status: "ACTIVE", tenantId: TENANT } });
  log("reference data created");

  // ---------- Employees (75) with hierarchy ----------
  const N = 75;
  const emps = [];
  const usedEmails = new Set();
  const mkName = () => `${pick(FIRST)} ${pick(LAST)}`;
  for (let i = 0; i < N; i++) {
    const name = mkName();
    const [first, last] = name.split(" ");
    let workEmail; do { workEmail = `${first}.${last}${rnd(9999)}@trusoft.example`.toLowerCase(); } while (usedEmails.has(workEmail));
    usedEmails.add(workEmail);
    const personalEmail = `${first}.${last}${rnd(9999)}@gmail.com`.toLowerCase();
    // grade distribution: top-heavy pyramid
    const gi = i === 0 ? 5 : i <= 6 ? 4 : i <= 20 ? 3 : i <= 40 ? 2 : i <= 58 ? 1 : 0;
    const bu = i === 0 ? bus[0] : bus[(i - 1) % bus.length];
    const pos = pick(positionsByBu[bu.name]);
    const hireDaysAgo = 60 + rnd(2200);
    const city = pick(Object.keys(CITY_META));
    const cm = CITY_META[city];
    const residential = `House ${1 + rnd(400)}, Street ${1 + rnd(40)}, ${pick(AREAS)}, ${city}`;
    // Probation ends 90d after joining (past for tenured staff, upcoming for recent hires).
    const joinDate = daysAgo(hireDaysAgo);
    const e = await prisma.employee.create({
      data: {
        tenant_id: TENANT,
        first_name: first, last_name: last, middle_name: rnd(3) === 0 ? pick(["Bin","Ul","Al"]) : null,
        preferred_name: rnd(3) === 0 ? first : null,
        employee_name: name, employee_code: `EMP-${String(i + 1).padStart(4, "0")}`,
        work_email: workEmail, email: personalEmail,
        personal_contact: `+9230${rnd(9)}${String(rnd(9999999)).padStart(7,"0")}`,
        work_phone: `+9221${String(rnd(9999999)).padStart(7,"0")}`,
        date_of_birth: daysAgo(365 * (24 + rnd(33)) + rnd(365)), // age ~24–57
        job_title: pos.title, gender: pick(["Male","Female"]), marital_status: pick(["Single","Married","Married"]),
        nationality: "Pakistani", nationality_id_type: "CNIC", nationality_id_no: mkCnic(),
        ntn: `${1000000 + rnd(8999999)}-${rnd(9)}`,
        current_address: residential, permenant_address: rnd(2) === 0 ? residential : `House ${1 + rnd(400)}, ${pick(AREAS)}, ${pick(Object.keys(CITY_META))}`,
        city, state: cm.province, province: cm.province, country: "Pakistan", postal_code: cm.postal,
        businessUnitId: bu.id, gradeLevelId: grades[gi].id, positionId: pos.id,
        employee_type: pick(["Permanent","Permanent","Contract"]), employement_status: "Active", status: "Active",
        hire_date: joinDate, joining_date: joinDate, probation_end_date: new Date(joinDate.getTime() + 90 * 86400000),
        fte: 1.0,
      },
    });
    e._gi = gi; e._bu = bu;
    emps.push(e);
  }
  // manager hierarchy: 0=CEO; 1..6 dept heads report to CEO; rest report to a head/lead of same BU
  for (let i = 1; i < N; i++) {
    let managerId;
    if (i <= 6) managerId = emps[0].id;
    else {
      const head = emps.slice(1, 7).find((h) => h._bu.id === emps[i]._bu.id) || emps[0];
      managerId = head.id;
    }
    await prisma.employee.update({ where: { id: emps[i].id }, data: { managerId } });
  }
  const admin = emps[0].id; // createdById for FK-required rows
  log(`${N} employees created + hierarchy`);

  // Regions (createdById required) + assign
  const regions = [];
  for (const n of ["Karachi HQ","Lahore Office","Islamabad Office"]) regions.push(await prisma.region.create({ data: { name: n, code: n.slice(0,3).toUpperCase(), createdById: admin, tenantId: TENANT } }));
  for (const e of emps) await prisma.employee.update({ where: { id: e.id }, data: { regionId: pick(regions).id } });

  // ---------- Comp: EmploymentTerms + BankDetail + allowances ----------
  const banks = ["Meezan Bank","HBL","UBL","Bank Alfalah","Standard Chartered"];
  for (const e of emps) {
    const base = GRADES[e._gi].base * (0.9 + Math.random() * 0.3);
    await prisma.employmentTerms.create({ data: { tenantId: TENANT, employeeId: e.id, baseSalary: round(base), currency: "PKR", payFrequency: "MONTHLY", bonusTarget: round(base * (1 + rnd(3))), equity: e._gi >= 4 ? `${(e._gi - 3) * 5000} RSUs` : null, effectiveFrom: e.hire_date } });
    const acct = `${rnd(9)}${String(rnd(999999999999)).padStart(12,"0")}`;
    await prisma.bankDetail.create({ data: { tenantId: TENANT, employeeId: e.id, bankName: pick(banks), accountTitle: e.employee_name, accountNumber: acct, iban: `PK${10+rnd(89)}MEZN${acct}`, branch: `${pick(["Gulberg","DHA","Clifton","Blue Area","Saddar"])}, ${e.city}`, disbursementMethod: "Bank Transfer", accountType: "SAVINGS", isPrimary: true } });
    // allowances as active assignments
    await prisma.payrollAssignment.create({ data: { tenantId: TENANT, employeeId: e.id, earningTypeId: earnTypes.HRA.id, amount: round(base * 0.4), isActive: true, effectiveFrom: e.hire_date } });
    await prisma.payrollAssignment.create({ data: { tenantId: TENANT, employeeId: e.id, earningTypeId: earnTypes.TA.id, amount: round(base * 0.1), isActive: true, effectiveFrom: e.hire_date } });
  }
  log("compensation + banking created");

  // ---------- Leave ----------
  const policies = [];
  for (const [name, code, days] of [["Annual Leave","AL",20],["Sick Leave","SL",10],["Casual Leave","CL",10]])
    policies.push(await prisma.leavePolicy.create({ data: { name, leaveTypeCode: code, accrualRate: days/12, accrualPeriod: "MONTHLY", carryForwardAllowed: code==="AL", maxCarryForward: 10, createdById: admin, tenantId: TENANT } }));
  for (const e of emps) {
    for (const p of policies) await prisma.leaveBalance.create({ data: { employeeId: e.id, leavePolicyId: p.id, balance: 4 + rnd(16), carryOverBalance: rnd(6), tenantId: TENANT } });
    // one past + maybe one upcoming request
    const p = pick(policies);
    await prisma.leaveRequest.create({ data: { employeeId: e.id, leavePolicyId: p.id, startDate: daysAgo(30 + rnd(120)), endDate: daysAgo(28 + rnd(120)), totalDays: 1 + rnd(3), reason: pick(["Family event","Medical","Personal","Vacation"]), status: "APPROVED", createdById: admin, tenantId: TENANT } });
    if (rnd(2) === 0) await prisma.leaveRequest.create({ data: { employeeId: e.id, leavePolicyId: p.id, startDate: daysAgo(-(5 + rnd(25))), endDate: daysAgo(-(3 + rnd(25))), totalDays: 1 + rnd(3), reason: pick(["Vacation","Personal"]), status: pick(["PENDING","APPROVED"]), createdById: admin, tenantId: TENANT } });
  }
  log("leave policies/balances/requests created");

  // ---------- Holidays ----------
  const cal = await prisma.holidayCalendar.create({ data: { name: "Pakistan Holidays", year: 2026, createdById: admin, tenantId: TENANT } });
  // Past + UPCOMING PK public holidays (relative to now) so the Leaves tab shows upcoming ones.
  for (const [name, date] of [["Pakistan Day","2026-03-23"],["Labour Day","2026-05-01"],["Eid ul-Adha","2026-06-07"],["Independence Day","2026-08-14"],["Iqbal Day","2026-11-09"],["Quaid-e-Azam Day","2026-12-25"],["Kashmir Day","2027-02-05"]])
    await prisma.holiday.create({ data: { holidayCalendarId: cal.id, date: new Date(date), name, fullDay: true, createdById: admin, tenantId: TENANT } });
  for (const e of emps) await prisma.employeeHolidayCalendar.create({ data: { employeeId: e.id, holidayCalendarId: cal.id, tenantId: TENANT } });
  log("holidays created");

  // ---------- Employee Documents (EmployeeMedia) ----------
  let docCount = 0;
  for (const e of emps) {
    // Every employee has CNIC + Contract + Offer + Degree; ~half also Experience Letter; ~30% Passport.
    const mine = DOC_TYPES.filter((d) => {
      if (["CNIC","Employment Contract","Offer Letter","Educational Certificate"].includes(d.title)) return true;
      if (d.title === "Experience Letter") return Math.random() < 0.5;
      if (d.title === "Passport") return Math.random() < 0.3;
      return false;
    });
    for (const d of mine) {
      // ~75% verified, rest pending; a few expiry docs fall within 90d to light the "expiring" stat.
      const status = Math.random() < 0.75 ? "verified" : "pending";
      const expiry = d.hasExpiry ? (Math.random() < 0.25 ? daysAgo(-(10 + rnd(80))) : daysAgo(-(200 + rnd(1500)))) : null;
      await prisma.employeeMedia.create({ data: {
        tenantId: TENANT, employee_id: e.id, title: d.title, category: d.category,
        version: "1", visibility: "hr", status,
        effective_date: e.hire_date.toISOString().slice(0, 10),
        expiry_date: expiry ? expiry.toISOString().slice(0, 10) : null,
        file_name: `${d.title.replace(/\s+/g,"_").toLowerCase()}_${e.employee_code}.${d.mime === "application/pdf" ? "pdf" : "jpg"}`,
        mime_type: d.mime, file_size: 40000 + rnd(2000000),
        notes: status === "pending" ? "Awaiting HR verification" : null,
      } });
      docCount++;
    }
  }
  log(`${docCount} employee documents created`);

  // ---------- Time & attendance ----------
  // One tenant overtime rule + a standard work schedule per employee, attendance
  // with real check_in/out/remarks, and timesheets backed by daily time entries.
  const otRule = await prisma.overtimeRule.create({ data: {
    name: "Standard Overtime Policy", description: "1.5x after 8h/day or 40h/week",
    daily_hours_threshold: 8, weekly_hours_threshold: 40,
    daily_overtime_rate: 1.5, weekly_overtime_rate: 1.5,
    max_hours_per_day: 12, max_hours_per_week: 60, is_active: true, tenantId: TENANT,
  } });
  const schedulePattern = {
    monday: "09:00-17:00", tuesday: "09:00-17:00", wednesday: "09:00-17:00",
    thursday: "09:00-17:00", friday: "09:00-17:00", saturday: "off", sunday: "off",
  };
  for (const e of emps) {
    let attData = [];
    for (let d = 1; d <= 30; d++) {
      const day = daysAgo(d); const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const st = Math.random() < 0.9 ? "PRESENT" : Math.random() < 0.6 ? "LATE" : "ABSENT";
      if (st === "ABSENT") {
        attData.push({ employeeId: e.id, date: day, status: st, total_hours: 0, remarks: "Absent — no attendance recorded", tenantId: TENANT });
      } else {
        const late = st === "LATE";
        const ci = atClock(day, 9, late ? 45 + rnd(70) : rnd(18));
        const hours = round2(8 + Math.random() * 1.5);
        attData.push({ employeeId: e.id, date: day, status: st, check_in: ci, check_out: addHours(ci, hours), total_hours: hours, remarks: late ? "Late arrival" : "On time", tenantId: TENANT });
      }
    }
    await prisma.attendance.createMany({ data: attData });

    await prisma.workSchedule.create({ data: {
      employeeId: e.id, schedule_name: "Standard 40h Week",
      effective_start_date: e.joining_date || e.hire_date || daysAgo(365),
      total_hours_per_week: 40, schedule_pattern: schedulePattern,
      overtimeRuleId: otRule.id, tenantId: TENANT,
    } });

    // current-month timesheet (so "hours completed this month" is populated) + prior month,
    // each backed by daily REGULAR time entries across weekdays in the period.
    const som = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const periods = [
      { start: som, end: daysAgo(1), status: "SUBMITTED" },
      { start: daysAgo(58), end: daysAgo(30), status: "APPROVED" },
    ];
    for (const p of periods) {
      const entries = [];
      const day = new Date(Date.UTC(p.start.getUTCFullYear(), p.start.getUTCMonth(), p.start.getUTCDate()));
      while (day <= p.end) {
        if (isWeekday(day)) {
          const start = atClock(day, 9, rnd(15)); const dur = 8 * 60 + rnd(60);
          entries.push({ employeeId: e.id, work_date: new Date(day), start_time: start, end_time: new Date(start.getTime() + dur * 60000), duration_minutes: dur, work_type: "REGULAR", entry_type: "MANUAL_ENTRY", note: "Regular working day", tenantId: TENANT });
        }
        day.setUTCDate(day.getUTCDate() + 1);
      }
      const totalHours = round2(entries.reduce((s, x) => s + x.duration_minutes, 0) / 60);
      const ts = await prisma.timesheet.create({ data: { employeeId: e.id, period_start: p.start, period_end: p.end, total_hours: totalHours, status: p.status, tenantId: TENANT } });
      if (entries.length) await prisma.timeEntry.createMany({ data: entries.map((x) => ({ ...x, timesheetId: ts.id })) });
    }
  }
  log("attendance + work schedules + timesheets + time entries created");

  // ---------- Payroll: 3 monthly runs + payslips ----------
  for (let mo = 3; mo >= 1; mo--) {
    const pStart = new Date(Date.UTC(2026, 6 - mo, 1));
    const pEnd = new Date(Date.UTC(2026, 6 - mo + 1, 0));
    const run = await prisma.payrollRun.create({ data: { tenantId: TENANT, periodStart: pStart, periodEnd: pEnd, countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", processedAt: new Date(Date.UTC(2026, 6 - mo + 1, 1)) } });
    for (const e of emps) {
      const base = GRADES[e._gi].base;
      const hra = round(base * 0.4), ta = round(base * 0.1), gross = base + hra + ta;
      const annual = base * 12;
      const taxRate = annual > 4800000 ? 0.25 : annual > 2400000 ? 0.2 : annual > 1200000 ? 0.12 : 0.05;
      const tax = round((gross * taxRate)); const eobi = 250; const pf = round(base * 0.05);
      const totalDed = tax + eobi + pf; const net = gross - totalDed;
      await prisma.payrollPayslip.create({ data: {
        tenantId: TENANT, payrollRunId: run.id, employeeId: e.id, grossAmount: gross, totalDeductions: totalDed, netAmount: net, status: "DISTRIBUTED", distributedAt: run.processedAt,
        earnings: { create: [ { tenantId: TENANT, earningTypeId: earnTypes.BASIC.id, amount: base, description: "Basic Salary" }, { tenantId: TENANT, earningTypeId: earnTypes.HRA.id, amount: hra, description: "House Rent Allowance" }, { tenantId: TENANT, earningTypeId: earnTypes.TA.id, amount: ta, description: "Transport Allowance" } ] },
        deductions: { create: [ { tenantId: TENANT, deductionTypeId: dedTypes.INCOME_TAX.id, amount: tax, description: "Income Tax" }, { tenantId: TENANT, deductionTypeId: dedTypes.EOBI.id, amount: eobi, description: "EOBI" }, { tenantId: TENANT, deductionTypeId: dedTypes.PF.id, amount: pf, description: "Provident Fund" } ] },
      } });
    }
  }
  log("payroll runs + payslips created");

  // ---------- Performance: reviews + goals + recognition ----------
  for (const e of emps) {
    await prisma.performanceReview.create({ data: { employeeId: e.id, reviewerId: emps[0].id, cycleId: cycle.id, period_start: fy26From, period_end: new Date("2026-06-30"), overall_rating: 2.5 + Math.random() * 2.5, status: "FINALIZED", type: "MANAGER", submittedAt: daysAgo(20 + rnd(40)), comments: pick(["Strong contributor.","Exceeds expectations.","Meets expectations.","Solid year with growth areas."]), tenantId: TENANT } });
    const nGoals = 2 + rnd(3);
    for (let g = 0; g < nGoals; g++) {
      const prog = rnd(101);
      await prisma.goal.create({ data: { employeeId: e.id, title: pick(["Ship Q3 roadmap","Improve NPS by 10%","Reduce cycle time","Mentor 2 juniors","Close $200k pipeline","Automate reporting"]), category: pick(["Business","Personal Development","Team"]), start_date: fy26From, end_date: new Date("2026-06-30"), target_value: 100, current_value: prog, progress: prog, status: prog >= 100 ? "COMPLETED" : "IN_PROGRESS", tenantId: TENANT } });
    }
    if (Math.random() < 0.4) await prisma.recognition.create({ data: { employeeId: e.id, title: pick(["Star Performer","Spot Award","Values Champion","Milestone: 3 Years"]), category: pick(["Award","Kudos","Spot Bonus","Milestone"]), givenById: emps[0].id, awardedAt: daysAgo(rnd(180)), tenantId: TENANT } });
  }
  log("performance + goals + recognition created");

  // ---------- Skills / Certs / Training ----------
  for (const e of emps) {
    const mySkills = sample(SKILLS, 3 + rnd(4));
    for (const s of mySkills) { const sc = 40 + rnd(60); await prisma.employeeSkill.create({ data: { employeeId: e.id, skillId: skillRows[s].id, score: sc, level: scoreToLevel(sc), proficiency: scoreToLevel(sc), source: "seed", tenantId: TENANT } }); }
    for (const c of sample(COMPETENCIES, 2 + rnd(2))) { const sc = 45 + rnd(55); await prisma.employeeSkill.create({ data: { employeeId: e.id, skillId: skillRows[c].id, score: sc, level: scoreToLevel(sc), proficiency: scoreToLevel(sc), source: "seed", tenantId: TENANT } }); }
    if (Math.random() < 0.5) await prisma.certification.create({ data: { employeeId: e.id, name: pick(["AWS Certified Developer","CKA","PMP","CFA Level 1","Google Analytics"]), issuedBy: pick(["Amazon","CNCF","PMI","CFA Institute","Google"]), issuedAt: daysAgo(200 + rnd(600)), expiryDate: daysAgo(-(300 + rnd(400))), credentialId: `CRED-${rnd(999999)}`, tenantId: TENANT } });
    for (const co of sample(courses, 1 + rnd(3))) { const done = Math.random() < 0.6; await prisma.trainingEnrollment.create({ data: { courseId: co.id, employeeId: e.id, progress: done ? 100 : rnd(90), status: done ? "COMPLETED" : "IN_PROGRESS", score: done ? 60 + rnd(40) : null, completionDate: done ? daysAgo(rnd(120)) : null, tenantId: TENANT } }); }
    if (Math.random() < 0.5) await prisma.learningPathEnrollment.create({ data: { learningPathId: pick(paths).id, employeeId: e.id, progress: rnd(100), status: pick(["ENROLLED","IN_PROGRESS"]), tenantId: TENANT } });
  }
  log("skills / certs / training created");

  // ---------- RBAC: departments + roles + users (+ activity) ----------
  if (process.env.SKIP_RBAC === "1") {
    log("SKIP_RBAC=1 → skipping RBAC user generation");
  } else {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/erp-rbac";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const q = (t, v) => client.query(t, v);
  // departments (reuse-or-create under company 2)
  const deptIds = {};
  for (const n of BU_NAMES) {
    const r = await q(`insert into "Department"(name,description,"companyId",created_at,updated_at) values($1,$2,$3,now(),now()) returning id`, [n, `${n} department`, COMPANY_ID]);
    deptIds[n] = r.rows[0].id;
  }
  // roles under company 2
  const roleIds = {};
  for (const n of ["Employee (Trusoft)","Team Lead (Trusoft)","Manager (Trusoft)","Director (Trusoft)"]) {
    const r = await q(`insert into "Role"(name,description,"companyId",created_at,updated_at) values($1,$2,$3,now(),now()) returning id`, [n, n, COMPANY_ID]);
    roleIds[n] = r.rows[0].id;
  }
  const roleForGrade = (gi) => gi >= 5 ? roleIds["Director (Trusoft)"] : gi >= 4 ? roleIds["Manager (Trusoft)"] : gi >= 3 ? roleIds["Team Lead (Trusoft)"] : roleIds["Employee (Trusoft)"];
  const pwHash = await bcrypt.hash("Password@123", 10);
  let rbacUsers = 0;
  for (const e of emps) {
    const uname = `${e.employee_name.replace(/\s+/g,"").toLowerCase()}${e.id}`;
    const ur = await q(`insert into "User"(user_name,email,password,"employeeId","roleId",pv,failed_attempts,locked,created_at,updated_at)
                        values($1,$2,$3,$4,$5,0,$6,false,now(),now()) returning id`,
      [uname, e.work_email, pwHash, e.id, roleForGrade(e._gi), rnd(3)]);
    const uid = ur.rows[0].id;
    await q(`insert into "_UserDepartments"("A","B") values($1,$2) on conflict do nothing`, [deptIds[e._bu.name], uid]);
    // 2FA (~40% enabled)
    await q(`insert into "TwoFactorAuthentication"("userId",enabled,verified,method,created_at,updated_at) values($1,$2,$2,$3,now(),now())`, [uid, Math.random()<0.4, "EMAIL"]);
    // login history + sessions (activity tab)
    const nLogins = 1 + rnd(4);
    for (let l = 0; l < nLogins; l++) await q(`insert into "LoginHistory"(id,"userId","tenantId",ip,fingerprint,"createdAt") values(gen_random_uuid(),$1,$2,$3,$4,$5)`, [uid, TENANT, `39.${rnd(255)}.${rnd(255)}.${rnd(255)}`, `fp_${rnd(1e9).toString(16)}`, daysAgo(rnd(20))]);
    const nSess = 1 + rnd(2);
    for (let s = 0; s < nSess; s++) { const start = daysAgo(rnd(25)); await q(`insert into "Session"("userId",sid,start_time,end_time,token,token_expire,ip_address,os,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`, [uid, `sid_${uid}_${s}_${rnd(1e6)}`, start, s===0?null:new Date(start.getTime()+3600000), "seed-token", new Date(start.getTime()+86400000), `39.${rnd(255)}.${rnd(255)}.${rnd(255)}`, pick(["Windows 11","macOS 14","Ubuntu 22.04","Android 14","iOS 17"])]); }
    rbacUsers++;
  }
  await client.end();
  log(`${rbacUsers} RBAC users (+2FA/logins/sessions) created under company ${COMPANY_ID}`);
  }

  // ---------- summary ----------
  const counts = {
    employees: await prisma.employee.count(),
    payslips: await prisma.payrollPayslip.count(),
    attendance: await prisma.attendance.count(),
    timesheets: await prisma.timesheet.count(),
    timeEntries: await prisma.timeEntry.count(),
    workSchedules: await prisma.workSchedule.count(),
    goals: await prisma.goal.count(),
    employeeSkills: await prisma.employeeSkill.count(),
    leaveBalances: await prisma.leaveBalance.count(),
  };
  log("DONE. counts: " + JSON.stringify(counts));
}

// Run inside the tenant ALS context so the prisma rlsTenantExtension sets
// app.tenant_id per-op (Attendance / PerformanceReview / leave_requests are FORCE-RLS).
mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => { console.error("SEED ERROR:", e); await prisma.$disconnect(); process.exit(1); });
});
