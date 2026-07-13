// src/services/employeeProfile.service.js — consolidated employee profile.
//
// Backs the hr_employee_profile_get MCP tool. Assembles ONE object from:
//   * Employee row (middle name, ntn, pay grade)          — HR DB
//   * BankDetail primary (A/C title, bank, account #, IBAN, branch, disbursement)
//   * EmploymentTerms (compensation history)               — HR DB
//   * PayrollPayslip.deductions (EOBI / PF / income tax, monthly + YTD tax)
//   * PayrollRun.processedAt (pay date), payslip netAmount (disbursement)
//   * TaxRate (Pakistan FY Jul–Jun tax slab)               — HR DB
//   * EmployeeSkill/Skill (skills + competencies), Certification, documents
//   * Company name + Department name(s)                    — RBAC (by-employee)
//
// Reads go through the C4-extended prisma singleton (src/lib/prisma.js), so
// accountNumber / iban / ntn / baseSalary come back DECRYPTED transparently.
//
// Sensitive fields (raw salary, full account/iban, ntn) are only surfaced when
// showSensitive is true (caller holds hr:payroll VIEW or is admin) — mirrors
// employeeCompensation.service.js. Otherwise they are masked, never dropped.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";
import { getUserByEmployeeId } from "./rbac.client.js";

const FREQ_PER_YEAR = { WEEKLY: 52, BI_WEEKLY: 26, SEMI_MONTHLY: 24, MONTHLY: 12 };

// ---- Pakistan fiscal year (1 Jul (Y-1) .. 30 Jun (Y)); FY26 == 2025-07..2026-06.
const pkFiscalYearBounds = (year) => ({
  year,
  label: `FY${String(year).slice(-2)}`,
  start: new Date(Date.UTC(year - 1, 6, 1, 0, 0, 0)),
  end: new Date(Date.UTC(year, 5, 30, 23, 59, 59, 999)),
});

const pkFiscalYearForDate = (d) => {
  const dt = d ? new Date(d) : new Date();
  const y = dt.getUTCFullYear();
  // Jul..Dec belongs to next calendar year's FY; Jan..Jun to this year's FY.
  return pkFiscalYearBounds(dt.getUTCMonth() >= 6 ? y + 1 : y);
};

// Normalize a caller-supplied fiscal-year hint ("FY26" | "26" | 2026 | "2026").
const resolveFiscalYear = (hint, fallbackDate) => {
  if (hint == null || hint === "") return pkFiscalYearForDate(fallbackDate);
  const digits = String(hint).replace(/[^0-9]/g, "");
  if (!digits) return pkFiscalYearForDate(fallbackDate);
  const n = Number(digits);
  return pkFiscalYearBounds(n < 100 ? 2000 + n : n);
};

// ---- statutory deduction-type name/code matchers (case-insensitive) ----------
const isEobi = (s = "") => /eobi/i.test(s);
const isProvidentFund = (s = "") => /provident|(^|[^a-z])pf([^a-z]|$)/i.test(s);
const isIncomeTax = (s = "") => /income[\s_-]*tax/i.test(s) || /(^|[^a-z])tax([^a-z]|$)/i.test(s);

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const maskAccount = (v) => {
  const s = String(v ?? "");
  return s ? `****${s.slice(-4)}` : null;
};

// Full name incl. middle name.
const fullName = (e) =>
  e.employee_name || [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" ") || null;

/**
 * Shape the primary bank block for the profile.
 * @param {object|null} bank  decrypted BankDetail row
 * @param {boolean} showSensitive
 */
const bankBlock = (bank, showSensitive) => {
  if (!bank) return null;
  return {
    id: bank.id,
    accountTitle: bank.accountTitle ?? null, // A/C Title
    bankName: bank.bankName ?? null, // Bank
    accountNumber: showSensitive ? (bank.accountNumber ?? null) : maskAccount(bank.accountNumber), // Account #
    iban: showSensitive ? (bank.iban ?? null) : maskAccount(bank.iban), // IBAN (encrypted at rest)
    branch: bank.branch ?? null, // Branch
    disbursementMethod: bank.disbursementMethod ?? null, // Disbursement (method)
    accountType: bank.accountType ?? null,
    routingNumber: showSensitive ? (bank.routingNumber ?? null) : null,
    isPrimary: bank.isPrimary,
    restricted: !showSensitive,
  };
};

const compTermsRow = (t, showSensitive) => ({
  id: t.id,
  baseSalary: showSensitive ? num(t.baseSalary) : null,
  bonusTarget: showSensitive ? num(t.bonusTarget) : null,
  currency: t.currency,
  payFrequency: t.payFrequency,
  effectiveFrom: t.effectiveFrom,
  effectiveTo: t.effectiveTo ?? null,
});

/**
 * Get the consolidated employee profile.
 *
 * @param {string|number} employeeId
 * @param {string|null}   tenantId       verified RBAC Company.uuid (service-JWT)
 * @param {object}        opts
 * @param {boolean}       [opts.showSensitive=false]  surface raw salary/account/iban/ntn
 * @param {string|number} [opts.taxFiscalYear]        override PK FY for the tax slab (e.g. "FY26")
 */
export async function getEmployeeConsolidatedProfile(employeeId, tenantId, opts = {}) {
  const id = Number(employeeId);
  if (!Number.isFinite(id)) throw Object.assign(new Error("Invalid employee ID"), { status: 400 });
  const showSensitive = Boolean(opts.showSensitive);

  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id }),
    select: {
      id: true,
      tenant_id: true,
      employee_code: true,
      first_name: true,
      middle_name: true,
      last_name: true,
      employee_name: true,
      job_title: true,
      hire_date: true,
      ntn: true, // C4-decrypted on read
      gradeLevel: { select: { name: true } }, // Pay grade
      Position: { select: { title: true } },
      employmentTerms: { orderBy: [{ effectiveFrom: "desc" }], take: 10 }, // decrypted salaries
      bankDetails: { orderBy: [{ isPrimary: "desc" }, { created_at: "desc" }], take: 5 }, // decrypted acct/iban
      skills: {
        include: { skill: { select: { id: true, name: true, category: true } } },
        orderBy: [{ addedAt: "desc" }],
      },
      certifications: { orderBy: [{ issuedAt: "desc" }] },
      employee_media: { orderBy: { id: "desc" } },
      payrollPayslips: {
        orderBy: [{ created_at: "desc" }],
        take: 60,
        select: {
          id: true,
          created_at: true,
          status: true,
          netAmount: true,
          distributedAt: true,
          payrollRun: { select: { id: true, periodStart: true, periodEnd: true, processedAt: true } },
          deductions: {
            select: {
              amount: true,
              description: true,
              deductionType: { select: { id: true, code: true, name: true, rate: true } },
            },
          },
        },
      },
    },
  });

  if (!employee) throw Object.assign(new Error("Employee not found"), { status: 404 });

  // ---- Org identity from RBAC (fail-soft) ----
  const org = await getUserByEmployeeId(id);

  // ---- Bank ----
  const primaryBank =
    employee.bankDetails?.find((b) => b.isPrimary) ?? employee.bankDetails?.[0] ?? null;

  // ---- Compensation ----
  const currentTerms = employee.employmentTerms?.[0] ?? null;
  const historyTerms = employee.employmentTerms?.slice(1) ?? [];
  const currency = currentTerms?.currency ?? null;

  // ---- Payslips (newest first) ----
  const payslips = employee.payrollPayslips ?? [];
  const payslipDate = (p) => p.payrollRun?.processedAt || p.distributedAt || p.payrollRun?.periodEnd || p.created_at;
  const latestPayslip = payslips[0] ?? null;

  // Pay date — derived from the latest payroll run's processedAt (per decision).
  const payDate = latestPayslip
    ? latestPayslip.payrollRun?.processedAt || latestPayslip.distributedAt || latestPayslip.payrollRun?.periodEnd || null
    : null;

  // Disbursement — method is settable on BankDetail; net paid comes from the latest payslip.
  const disbursement = {
    method: primaryBank?.disbursementMethod || (primaryBank ? "Bank Transfer" : null),
    netPaid: latestPayslip ? num(latestPayslip.netAmount) : null,
    currency,
    payslipId: latestPayslip?.id ?? null,
    paidAt: payDate,
  };

  // Most-recent deduction amount for a type predicate (scans payslips newest-first).
  const latestDeduction = (pred) => {
    for (const p of payslips) {
      const hit = (p.deductions || []).find(
        (d) => pred(d.deductionType?.name || "") || pred(d.deductionType?.code || "") || pred(d.description || "")
      );
      if (hit) return { amount: num(hit.amount), type: hit.deductionType || null, payslipId: p.id, paidAt: payslipDate(p) };
    }
    return null;
  };

  const eobiHit = latestDeduction(isEobi);
  const pfHit = latestDeduction(isProvidentFund);

  const statutory = {
    eobi: eobiHit
      ? { typeName: eobiHit.type?.name ?? "EOBI", code: eobiHit.type?.code ?? null, rate: num(eobiHit.type?.rate), monthlyAmount: eobiHit.amount }
      : null,
    providentFund: pfHit
      ? { typeName: pfHit.type?.name ?? "Provident Fund", code: pfHit.type?.code ?? null, rate: num(pfHit.type?.rate), monthlyAmount: pfHit.amount }
      : null,
  };

  // ---- Income tax: monthly (latest payslip) + YTD (sum over PK fiscal year) ----
  const fy = resolveFiscalYear(opts.taxFiscalYear, payDate);
  const incomeTaxHit = latestDeduction(isIncomeTax);
  let ytdTax = 0;
  let ytdCount = 0;
  for (const p of payslips) {
    const d = new Date(payslipDate(p));
    if (d >= fy.start && d <= fy.end) {
      for (const ded of p.deductions || []) {
        if (isIncomeTax(ded.deductionType?.name || "") || isIncomeTax(ded.deductionType?.code || "") || isIncomeTax(ded.description || "")) {
          ytdTax += num(ded.amount) || 0;
          ytdCount += 1;
        }
      }
    }
  }
  const tax = {
    fiscalYear: fy.label,
    fiscalYearStart: fy.start,
    fiscalYearEnd: fy.end,
    monthlyTaxPaid: incomeTaxHit ? incomeTaxHit.amount : null,
    monthlyTaxPayslipId: incomeTaxHit ? incomeTaxHit.payslipId : null,
    ytdTaxPaid: ytdCount ? ytdTax : null,
    ytdPayslipCount: ytdCount,
  };

  // ---- Tax slab from TaxRate (Pakistan, effective in the FY window) ----
  const annualBase = currentTerms
    ? (num(currentTerms.baseSalary) || 0) * (FREQ_PER_YEAR[currentTerms.payFrequency] || 12)
    : null;
  const taxSlab = await resolveTaxSlab(tenantId, fy, annualBase, showSensitive);

  // ---- Skills vs competencies (category on the Skill catalog row) ----
  const skillRow = (es) => ({
    id: es.skill?.id ?? es.skillId,
    name: es.skill?.name ?? null,
    category: es.skill?.category ?? null,
    score: es.score ?? null,
    level: es.level ?? es.proficiency ?? null,
    proficiency: es.proficiency ?? null,
    source: es.source ?? null,
    verified: es.verified,
  });
  const allSkills = (employee.skills || []).map(skillRow);
  const competencies = allSkills.filter((s) => String(s.category || "").toLowerCase() === "competency");
  const skills = allSkills.filter((s) => String(s.category || "").toLowerCase() !== "competency");

  const certifications = (employee.certifications || []).map((c) => ({
    id: c.id,
    name: c.name,
    issuedBy: c.issuedBy ?? null,
    issuedAt: c.issuedAt ?? null,
    expiryDate: c.expiryDate ?? null,
    credentialId: c.credentialId ?? null,
    certificateMediaId: c.certificateMediaId ?? null,
  }));

  const documents = (employee.employee_media || []).map((m) => ({
    id: m.id,
    title: m.title,
    category: m.category,
    fileName: m.file_name,
    mimeType: m.mime_type,
    fileSize: m.file_size,
    mediaId: m.media_id,
    downloadUrl: m.download_url,
    uploadedAt: m.uploaded_at,
    status: m.status,
  }));

  logger.debug({ employeeId: id, tenantId, showSensitive, fy: fy.label }, "hr: getEmployeeConsolidatedProfile");

  return {
    employeeId: id,
    employeeCode: employee.employee_code,
    name: fullName(employee),
    firstName: employee.first_name,
    middleName: employee.middle_name, // Middle name
    lastName: employee.last_name,
    jobTitle: employee.job_title ?? employee.Position?.title ?? null,

    // Org identity (RBAC).
    companyName: org.companyName, // Company name
    departments: org.departments, // Department name(s)
    departmentName: org.departments?.[0] ?? null,

    payGrade: employee.gradeLevel?.name ?? null, // Pay grade
    ntn: showSensitive ? (employee.ntn ?? null) : (employee.ntn ? maskAccount(employee.ntn) : null), // NTN

    // Banking + payment.
    bank: bankBlock(primaryBank, showSensitive), // A/C Title, Bank, Account #, IBAN, Branch
    payDate, // Pay date (derived)
    disbursement, // Disbursement

    // Tax.
    taxSlab, // Tax slab (FY)
    tax, // monthly + YTD tax paid

    // Statutory deductions.
    eobi: statutory.eobi, // EOBI
    providentFund: statutory.providentFund, // Provident fund

    // Compensation.
    compensation: {
      current: currentTerms ? compTermsRow(currentTerms, showSensitive) : null,
      history: historyTerms.map((t) => compTermsRow(t, showSensitive)), // Compensation history
      restricted: !showSensitive,
    },

    // Skills / competencies / certifications (AI-resume-parsed or manual).
    skills,
    competencies,
    certifications,

    documents, // Employee Documents

    meta: {
      tenantId: employee.tenant_id ?? null,
      sensitiveIncluded: showSensitive,
      orgResolved: Boolean(org.raw),
    },
  };
}

/**
 * Resolve the applicable Pakistan tax slab for an annual base from the TaxRate
 * table (country PK, effective within the FY window). Returns the matched
 * bracket + the full schedule for context. Returns null if no PK rates exist.
 */
async function resolveTaxSlab(tenantId, fy, annualBase, showSensitive) {
  const rates = await prisma.taxRate.findMany({
    where: {
      countryCode: "PK",
      effectiveFrom: { lte: fy.end },
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: fy.start } }] }],
      ...(tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : {}),
    },
    orderBy: [{ bracketMin: "asc" }],
  });
  if (!rates.length) return null;

  const schedule = rates.map((r) => ({
    bracketMin: num(r.bracketMin),
    bracketMax: r.bracketMax == null ? null : num(r.bracketMax),
    rate: num(r.rate),
  }));

  let matched = null;
  if (annualBase != null && showSensitive) {
    matched =
      schedule.find(
        (s) => annualBase >= (s.bracketMin ?? 0) && (s.bracketMax == null || annualBase <= s.bracketMax)
      ) ?? null;
  }

  return {
    fiscalYear: fy.label,
    countryCode: "PK",
    annualBaseUsed: showSensitive ? annualBase : null,
    matchedBracket: matched,
    schedule,
    restricted: !showSensitive,
  };
}
