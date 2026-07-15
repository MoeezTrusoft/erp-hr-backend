// src/services/employeeCompensation.service.js — Phase 3 / HR-COMP-01
//
// Surfaces C4-encrypted EmploymentTerms + BankDetail for an employee under
// the Job & Compensation profile tab. The C4 extension on the prisma singleton
// transparently decrypts baseSalary / bonusTarget / accountNumber on read, so
// this service always works with plaintext Numbers/Strings in memory — no
// explicit decrypt call needed here.
//
// Access control:
//   The MCP tool layer MUST call assertPermission('hr:compensation', 'GET')
//   before invoking these functions. Banking fields are only surfaced when
//   the caller holds 'hr:payroll' VIEW permission (passed as `showBanking`).
//
// Tenancy:
//   All queries are scoped to the verified tenantId from the service-JWT claim.

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { scopedEmployeeWhere } from '../lib/tenancy.js';

/**
 * Mask a numeric salary value. Returns null for callers without payroll access.
 * Returns the raw number for authorized callers.
 */
const maskSalary = (value, showBanking) => {
  if (!showBanking) return null;
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
};

/**
 * Shape a BankDetail row. Redact account number to last-4 digits for
 * callers that are not payroll-authorized.
 */
const bankDetailRow = (detail, showBanking) => {
  if (!detail) return null;
  const acct = detail.accountNumber ?? '';
  return {
    id: detail.id,
    bankName: detail.bankName,
    accountNumber: showBanking ? acct : `****${acct.slice(-4)}`,
    accountType: detail.accountType,
    isPrimary: detail.isPrimary,
    routingNumber: showBanking ? (detail.routingNumber ?? null) : null,
  };
};

/**
 * Shape an EmploymentTerms row into the compensation block the FE expects.
 */
const compensationTermsRow = (terms, showBanking) => ({
  id: terms.id,
  baseSalary: maskSalary(terms.baseSalary, showBanking),
  bonusTarget: maskSalary(terms.bonusTarget, showBanking),
  currency: terms.currency,
  payFrequency: terms.payFrequency,
  effectiveFrom: terms.effectiveFrom,
  effectiveTo: terms.effectiveTo ?? null,
});

/**
 * Fetch the most-recent compensation snapshot + banking information for an employee.
 *
 * @param {string|number} employeeId
 * @param {string|null}   tenantId   — verified RBAC Company.uuid from service-JWT.
 * @param {object}        opts
 * @param {boolean}       [opts.showBanking=false] — if true, surface raw numbers & bank account.
 * @returns {Promise<object>} compensation shape consumed by hr_employee_compensation_get.
 */
export async function getEmployeeCompensation(employeeId, tenantId, { showBanking = false } = {}) {
  const id = Number(employeeId);
  if (!Number.isFinite(id)) throw Object.assign(new Error('Invalid employee ID'), { status: 400 });

  // Verify the employee exists and belongs to the caller's tenant.
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id }),
    select: {
      id: true,
      first_name: true,
      last_name: true,
      employee_code: true,
      job_title: true,
      positionId: true,
      hire_date: true,
      // Compensation history — ordered newest first so [0] is the live terms.
      employmentTerms: {
        orderBy: [{ effectiveFrom: 'desc' }],
        take: 10,
      },
      // Banking — primary first, then secondary.
      bankDetails: {
        orderBy: [{ isPrimary: 'desc' }, { created_at: 'desc' }],
        take: 5,
      },
      gradeLevel: { select: { name: true } },
      Position: { select: { title: true } },
    },
  });

  if (!employee) throw Object.assign(new Error('Employee not found'), { status: 404 });

  const currentTerms = employee.employmentTerms?.[0] ?? null;
  const historyTerms = employee.employmentTerms?.slice(1) ?? [];
  const primaryBank = employee.bankDetails?.find((b) => b.isPrimary) ?? employee.bankDetails?.[0] ?? null;

  logger.debug(
    { employeeId: id, tenantId, showBanking, hasTerms: Boolean(currentTerms) },
    'hr: getEmployeeCompensation'
  );

  return {
    employeeId: id,
    employeeCode: employee.employee_code,
    name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
    jobTitle: employee.job_title ?? employee.Position?.title ?? null,
    payGrade: employee.gradeLevel?.name ?? null,
    hireDate: employee.hire_date ?? null,

    // Current active compensation.
    current: currentTerms ? compensationTermsRow(currentTerms, showBanking) : null,

    // Compensation history (masked unless payroll-authorized).
    history: historyTerms.map((t) => compensationTermsRow(t, showBanking)),

    // Banking details — only surfaced when showBanking is true.
    bankDetail: showBanking ? bankDetailRow(primaryBank, showBanking) : null,
    bankingRestricted: !showBanking,
  };
}
