import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { redactC4 } from "../lib/c4Redaction.js";
import * as money from "../lib/money.js";
import { withTenant } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { payrollRunFinalizedEvent } from "./hrEvents.js";
import { assertIfMatch } from "../lib/optimisticConcurrency.js";

// HR-02 / HR-07 (T-P4.1) — DETERMINISTIC, VERSIONED, APPROVAL-GATED payroll.
//
// The legacy engine was non-conformant on three axes:
//   * Tax was HARDCODED (grossAmount*0.15 / *0.05), ignoring the TaxRate table.
//   * All money was JS Float (`grossAmount += amount`, `baseSalary / 2`,
//     `* 12 / 52`) → cent-level rounding non-determinism.
//   * FINALIZE checked only status==='COMPLETED' — no human approval, no
//     separation of the processor from the approver.
//
// This module now:
//   1. Reads tax rates from the VERSIONED TaxRate snapshot effective for the
//      run's period + country (see selectEffectiveTaxRates), records the
//      ruleVersion / ratesEffectiveAt on the run + each payslip so a run is
//      reproducible against the rates that were in effect.
//   2. Does ALL arithmetic in INTEGER MINOR UNITS via src/lib/money.js
//      (round-half-up), converting to major-unit Numbers only at the DB
//      boundary. calculatePeriodSalaryMinor's /2 and *12/52 are exact and
//      total-preserving.
//   3. Requires a human approver DISTINCT from the processor before FINALIZE
//      (approvePayrollRun records approvedBy != processedBy; finalize blocks
//      without it and rejects self-approval).
//   4. Processing is idempotent — re-processing a run reuses existing payslips
//      (the [payrollRunId, employeeId] unique constraint) instead of doubling.
//
// The pure engine helpers (selectEffectiveTaxRates, computeProgressiveTaxMinor,
// computeRuleVersion, calculatePeriodSalaryMinor, buildPayslipFromInputs) are
// EXPORTED so the golden-file regression test drives the REAL engine — no mock
// copy of the logic (the deleted tests/unit/payrollCalculations.test.js
// anti-pattern).

// HR-04 / T-P2.2 — tenant-scope the payroll (C4) surface.
//
// The verified tenant arrives on req.user.tenantId (set by internalServiceGuard
// from the verified service-JWT claim — T-P2.1). The controllers thread that
// value into every service call as `tenantId`; NEVER from req.headers /
// x-tenant-id. Every payroll read/write below carries a tenantId predicate so
// tenant B can never read or mutate tenant A's salaries, payslips, bank/tax
// rows. A cross-tenant single-read resolves to null/not-found (the controller
// maps that to 404), never another tenant's data.
//
// `withTenant` folds the tenant predicate into a where-clause. We always apply
// it (even when tenantId is null) so the scoping is fail-closed: a null tenant
// only ever matches null-tenant (legacy/unbackfilled) rows, never another
// tenant's data. C.2 promoted this to the shared src/lib/tenancy.js so the same
// fail-closed definition scopes the rest of the HR tables — imported above.

// Coerce an actor id (header string / number) to an Int or null. Used to stamp
// processedBy / approvedBy so the separation-of-duties check compares integers.
const toInt = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// HR-02 / HR-07 — PURE, DETERMINISTIC ENGINE CORE (exported; no DB, no I/O)
//
// These functions are the testable heart of the payroll engine. They take plain
// inputs (employment term, assignments, the run, the tax-rate rows) and return
// exact, reproducible results in integer minor units / major-unit Numbers.
// ─────────────────────────────────────────────────────────────────────────────

// Annual→period rational factors. Bi-weekly/weekly approximate the year as
// 12 months; the math is done once, exactly (scaleRational), not as repeated
// float multiplication. Semi-monthly is an exact halving via allocateEvenly so
// the two halves reconstitute the monthly figure to the cent.
const PERIOD_FACTORS = {
    // payFrequency: { num, den } applied to the MONTHLY minor amount.
    BI_WEEKLY: { num: 12, den: 26 }, // 26 bi-weekly periods per year, 12 months
    WEEKLY: { num: 12, den: 52 },
};

/**
 * Period base salary in INTEGER MINOR UNITS. `employmentTerm.baseSalary` is the
 * (decrypted) monthly major-unit Number; we convert to minor units once, then
 * scale deterministically. SEMI_MONTHLY is the first half of an exact even
 * 2-way split so half*2 === monthly (no half-cent drift).
 */
export const calculatePeriodSalaryMinor = (employmentTerm /*, payrollRun */) => {
    const monthlyMinor = money.fromMajor(employmentTerm.baseSalary);
    switch (employmentTerm.payFrequency) {
        case 'MONTHLY':
            return monthlyMinor;
        case 'SEMI_MONTHLY':
            return money.allocateEvenly(monthlyMinor, 2)[0];
        case 'BI_WEEKLY':
            return money.scaleRational(monthlyMinor, PERIOD_FACTORS.BI_WEEKLY.num, PERIOD_FACTORS.BI_WEEKLY.den);
        case 'WEEKLY':
            return money.scaleRational(monthlyMinor, PERIOD_FACTORS.WEEKLY.num, PERIOD_FACTORS.WEEKLY.den);
        default:
            return monthlyMinor;
    }
};

/**
 * Select the TaxRate rows in effect for a given country at `asOf`, sorted by
 * bracketMin ascending. "Effective" = effectiveFrom <= asOf AND (effectiveTo is
 * null OR effectiveTo >= asOf). This is the versioned snapshot — a future rate
 * row or a foreign-country row is never selected. Pure: does not touch the DB.
 */
export const selectEffectiveTaxRates = (rateRows, { countryCode, asOf }) => {
    const at = asOf instanceof Date ? asOf : new Date(asOf);
    return (rateRows || [])
        .filter((r) => r.countryCode === countryCode)
        .filter((r) => {
            const from = r.effectiveFrom instanceof Date ? r.effectiveFrom : new Date(r.effectiveFrom);
            const to = r.effectiveTo == null ? null : (r.effectiveTo instanceof Date ? r.effectiveTo : new Date(r.effectiveTo));
            return from.getTime() <= at.getTime() && (to === null || to.getTime() >= at.getTime());
        })
        .sort((a, b) => a.bracketMin - b.bracketMin);
};

/**
 * Progressive bracket tax in INTEGER MINOR UNITS. `sortedRows` are the effective
 * rate rows (sorted by bracketMin). Each bracket taxes the slice of gross that
 * falls within [bracketMin, bracketMax) at `rate`; the open-ended top bracket
 * (bracketMax null) taxes the remainder. Bracket bounds are major-unit Numbers
 * (the TaxRate column shape) converted to minor units; the per-bracket multiply
 * rounds half-up once, then the bracket taxes are summed as integers — exact.
 */
export const computeProgressiveTaxMinor = (grossMinor, sortedRows) => {
    money.add(grossMinor, 0); // assert safe int
    let taxMinor = 0;
    for (const row of sortedRows) {
        const lowMinor = money.fromMajor(row.bracketMin);
        const highMinor = row.bracketMax == null ? null : money.fromMajor(row.bracketMax);
        if (grossMinor <= lowMinor) continue; // gross hasn't reached this bracket
        const upper = highMinor == null ? grossMinor : Math.min(grossMinor, highMinor);
        const sliceMinor = upper - lowMinor;
        if (sliceMinor <= 0) continue;
        taxMinor = money.add(taxMinor, money.mulRate(sliceMinor, row.rate));
    }
    return taxMinor;
};

/**
 * Deterministic, reproducible rule-version token for a set of effective rate
 * rows + the as-of instant. Same rows + same as-of → same version; ANY rate /
 * bracket / window change yields a different version. A short sha256 over a
 * canonical projection of the rows (id-independent: bracketMin/Max/rate/window)
 * so the version captures the actual computed rule, not row identity.
 */
export const computeRuleVersion = (sortedRows, asOf) => {
    const at = asOf instanceof Date ? asOf : new Date(asOf);
    const canonical = sortedRows.map((r) => ({
        countryCode: r.countryCode,
        bracketMin: r.bracketMin,
        bracketMax: r.bracketMax ?? null,
        rate: r.rate,
        effectiveFrom: new Date(r.effectiveFrom).toISOString(),
        effectiveTo: r.effectiveTo == null ? null : new Date(r.effectiveTo).toISOString(),
    }));
    const payload = JSON.stringify({ asOf: at.toISOString(), rules: canonical });
    return `v1:${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
};

/**
 * Build the canonical payslip object for one employee, PURELY (no DB). All money
 * is computed in integer minor units and emitted as major-unit Numbers at the
 * boundary. Earnings/deductions are produced in a FIXED order so the serialized
 * payslip is byte-stable (the golden-file determinism contract):
 *   earnings:   [ base salary, then each rate/flat earning assignment in order ]
 *   deductions: [ each deduction assignment in order, then each tax bracket line ]
 *
 * @returns {{ employeeId, ruleVersion, ratesEffectiveAt, grossAmount,
 *             totalDeductions, netAmount, earnings:[], deductions:[] }}
 */
export const buildPayslipFromInputs = ({ employee, employmentTerm, assignments = [], payrollRun, taxRateRows = [], asOf }) => {
    const at = asOf || payrollRun?.periodEnd;
    const earnings = [];
    const deductions = [];
    let grossMinor = 0;

    // 1) Base salary (if the employee has employment terms).
    if (employmentTerm) {
        const baseMinor = calculatePeriodSalaryMinor(employmentTerm, payrollRun);
        earnings.push({
            earningTypeId: employmentTerm.baseSalaryEarningTypeId ?? null,
            amount: money.toMajor(baseMinor),
            description: `Base salary for ${isoDate(payrollRun.periodStart)} to ${isoDate(payrollRun.periodEnd)}`,
        });
        grossMinor = money.add(grossMinor, baseMinor);
    }

    // 2) Assignment-driven earnings & deductions, in declared order. A flat
    //    `amount` is taken verbatim; a `rate` applies to gross-so-far (matching
    //    the legacy semantics) — both in minor units, rounded half-up once.
    for (const assignment of assignments) {
        if (assignment.earningType) {
            const amountMinor = assignment.amount != null
                ? money.fromMajor(assignment.amount)
                : money.mulRate(grossMinor, assignment.rate || 0);
            earnings.push({
                earningTypeId: assignment.earningType.id,
                amount: money.toMajor(amountMinor),
                description: assignment.earningType.name,
            });
            grossMinor = money.add(grossMinor, amountMinor);
        } else if (assignment.deductionType) {
            const amountMinor = assignment.amount != null
                ? money.fromMajor(assignment.amount)
                : money.mulRate(grossMinor, assignment.rate || 0);
            deductions.push({
                deductionTypeId: assignment.deductionType.id,
                amount: money.toMajor(amountMinor),
                description: assignment.deductionType.name,
            });
        }
    }

    // 3) Versioned tax: select the effective rows, compute progressive tax in
    //    minor units, record the rule version. One combined tax line keeps the
    //    payslip deterministic and matches the table-driven figure.
    const sorted = selectEffectiveTaxRates(taxRateRows, { countryCode: payrollRun.countryCode, asOf: at });
    const ruleVersion = computeRuleVersion(sorted, at);
    const taxMinor = computeProgressiveTaxMinor(grossMinor, sorted);
    if (taxMinor > 0 || sorted.length > 0) {
        deductions.push({
            deductionTypeId: null,
            amount: money.toMajor(taxMinor),
            description: 'Income Tax',
        });
    }

    const totalDeductionsMinor = money.sum(deductions.map((d) => money.fromMajor(d.amount)));
    const netMinor = money.sub(grossMinor, totalDeductionsMinor);

    return {
        employeeId: employee?.id ?? null,
        ruleVersion,
        ratesEffectiveAt: new Date(at).toISOString(),
        grossAmount: money.toMajor(grossMinor),
        totalDeductions: money.toMajor(totalDeductionsMinor),
        netAmount: money.toMajor(netMinor),
        earnings,
        deductions,
    };
};

const isoDate = (d) => new Date(d).toISOString().split('T')[0];

// Payroll Run Operations
export const getPayrollRuns = async ({ page, limit, status, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = withTenant(tenantId, status ? { status } : {});

    const [payrollRuns, total] = await Promise.all([
        prisma.payrollRun.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: { periodStart: 'desc' },
            include: {
                payslips: {
                    include: {
                        employee: {
                            select: { id: true, first_name: true, last_name: true }
                        }
                    }
                }
            }
        }),
        prisma.payrollRun.count({ where })
    ]);

    return {
        payrollRuns,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayrollRunById = async (id, tenantId) => {
    // findFirst (not findUnique) so the read carries the tenant predicate: a
    // cross-tenant id resolves to null → controller returns 404.
    return prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            payslips: {
                include: {
                    employee: {
                        select: { id: true, first_name: true, last_name: true, job_title: true }
                    },
                    earnings: {
                        include: {
                            earningType: true
                        }
                    },
                    deductions: {
                        include: {
                            deductionType: true
                        }
                    }
                }
            }
        }
    });
};

export const createPayrollRun = async (data, createdBy, tenantId) => {
  const existingRun = await prisma.payrollRun.findFirst({
    where: withTenant(tenantId, {
      OR: [
        {
          periodStart: { lte: data.periodEnd },
          periodEnd: { gte: data.periodStart }
        }
      ]
    })
  });

  if (existingRun) {
    throw new Error('Payroll run already exists for the specified period');
  }

  const create = await prisma.payrollRun.create({
    data: {
      ...data,
      tenantId: tenantId ?? null,
      status: 'PENDING'
    }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${create.id}" created successfully`
  });

  return create;
};

// Statuses a run may be (re-)processed FROM. PENDING is the first run; COMPLETED
// and FAILED allow an idempotent re-process (no doubled payslips). PROCESSING is
// allowed so a crashed run can be retried. APPROVED/FINALIZED/CANCELLED are
// terminal-ish and must NOT be silently re-computed.
const PROCESSABLE_STATUSES = new Set(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']);

export const processPayrollRun = async (id, updatedBy, tenantId) => {
    const payrollRun = await prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            payslips: true
        }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    if (!PROCESSABLE_STATUSES.has(payrollRun.status)) {
        throw new Error(`Payroll run cannot be processed from ${payrollRun.status} status`);
    }

    // Update status to PROCESSING (scoped: updateMany so the tenant predicate
    // applies — a cross-tenant id would touch zero rows). Stamp processedBy so
    // the approver can be enforced as a DISTINCT employee at finalize time.
    await prisma.payrollRun.updateMany({
        where: withTenant(tenantId, { id }),
        data: { status: 'PROCESSING', processedBy: toInt(updatedBy) }
    });

    try {
        // Get all active employees for this tenant
        const employees = await prisma.employee.findMany({
            where: { status: 'active', tenant_id: tenantId ?? null },
            include: {
                employmentTerms: {
                    where: withTenant(tenantId, {
                        effectiveFrom: { lte: payrollRun.periodEnd },
                        OR: [
                            { effectiveTo: null },
                            { effectiveTo: { gte: payrollRun.periodStart } }
                        ]
                    }),
                    orderBy: { effectiveFrom: 'desc' },
                    take: 1
                },
                payrollAssignments: {
                    where: withTenant(tenantId, {
                        effectiveFrom: { lte: payrollRun.periodEnd },
                        OR: [
                            { effectiveTo: null },
                            { effectiveTo: { gte: payrollRun.periodStart } }
                        ],
                        isActive: true
                    }),
                    include: {
                        earningType: true,
                        deductionType: true
                    }
                },
                attendance: {
                    where: {
                        date: {
                            gte: payrollRun.periodStart,
                            lte: payrollRun.periodEnd
                        }
                    }
                }
            }
        });

        // HR-02 — read the VERSIONED tax snapshot ONCE for the run's country,
        // effective at the run's period end. selectEffectiveTaxRates ignores
        // future-dated and foreign-country rows; computeRuleVersion records the
        // exact rule the run is computed against so it is reproducible.
        const allCountryRates = await prisma.taxRate.findMany({
            where: withTenant(tenantId, { countryCode: payrollRun.countryCode })
        });
        const ratesEffectiveAt = payrollRun.periodEnd;
        const effectiveRates = selectEffectiveTaxRates(allCountryRates, {
            countryCode: payrollRun.countryCode,
            asOf: ratesEffectiveAt
        });
        const ruleVersion = computeRuleVersion(effectiveRates, ratesEffectiveAt);

        // Resolve the persisted type ids the pure engine leaves null (base
        // salary earning, income tax deduction) once per run.
        const baseSalaryEarningTypeId = await getBaseSalaryEarningTypeId(tenantId);
        const incomeTaxDeductionTypeId = await getOrCreateDeductionType('INCOME_TAX', 'Income Tax', tenantId);

        const payslipPromises = employees.map(async (employee) => {
            const employmentTerm = employee.employmentTerms[0]
                ? { ...employee.employmentTerms[0], baseSalaryEarningTypeId }
                : null;

            // Build the canonical payslip with the REAL, deterministic engine.
            const built = buildPayslipFromInputs({
                employee,
                employmentTerm,
                assignments: employee.payrollAssignments,
                payrollRun,
                taxRateRows: allCountryRates,
                asOf: ratesEffectiveAt
            });

            // Map the engine's null-typed tax line to the resolved deduction type.
            const earnings = built.earnings.map((e) => ({
                earningTypeId: e.earningTypeId ?? baseSalaryEarningTypeId,
                amount: e.amount,
                description: e.description
            }));
            const deductions = built.deductions.map((d) => ({
                deductionTypeId: d.deductionTypeId ?? incomeTaxDeductionTypeId,
                amount: d.amount,
                description: d.description
            }));

            // IDEMPOTENCY: a payslip already exists for [payrollRunId, employeeId]
            // (unique constraint) on a re-process. Replace its lines + figures in
            // place instead of inserting a duplicate (the old code's create-in-a-
            // loop doubled payslips on re-run).
            const existing = await prisma.payrollPayslip.findFirst({
                where: withTenant(tenantId, { payrollRunId: id, employeeId: employee.id })
            });

            if (existing) {
                await prisma.payrollEarning.deleteMany({ where: { payslipId: existing.id } });
                await prisma.payrollDeduction.deleteMany({ where: { payslipId: existing.id } });
                return prisma.payrollPayslip.update({
                    where: { id: existing.id },
                    data: {
                        grossAmount: built.grossAmount,
                        totalDeductions: built.totalDeductions,
                        netAmount: built.netAmount,
                        ruleVersion,
                        status: 'DRAFT',
                        earnings: { create: earnings },
                        deductions: { create: deductions }
                    },
                    include: { earnings: true, deductions: true }
                });
            }

            return prisma.payrollPayslip.create({
                data: {
                    tenantId: tenantId ?? null,
                    payrollRunId: id,
                    employeeId: employee.id,
                    grossAmount: built.grossAmount,
                    totalDeductions: built.totalDeductions,
                    netAmount: built.netAmount,
                    ruleVersion,
                    status: 'DRAFT',
                    earnings: { create: earnings },
                    deductions: { create: deductions }
                },
                include: {
                    earnings: true,
                    deductions: true
                }
            });
        });

        const payslips = await Promise.all(payslipPromises);

        // Totals in integer minor units, then converted back once — exact, no
        // float drift across the per-payslip sum.
        const totalGross = money.toMajor(money.sum(payslips.map((p) => money.fromMajor(p.grossAmount))));
        const totalDeductions = money.toMajor(money.sum(payslips.map((p) => money.fromMajor(p.totalDeductions))));
        const totalNet = money.toMajor(money.sum(payslips.map((p) => money.fromMajor(p.netAmount))));

        // Update payroll run with totals (scoped). Record the rule version +
        // as-of so the run is reproducible against the rates in effect.
        await prisma.payrollRun.updateMany({
            where: withTenant(tenantId, { id }),
            data: {
                status: 'COMPLETED',
                totalGross,
                totalDeductions,
                totalNet,
                employeeCount: payslips.length,
                processedAt: new Date(),
                ruleVersion,
                ratesEffectiveAt
            }
        });

        const updatedRun = await getPayrollRunById(id, tenantId);

        // Create audit log (tenant-stamped)
        await prisma.payrollAuditLog.create({
            data: {
                tenantId: tenantId ?? null,
                action: 'PAYROLL_PROCESSED',
                details: `Payroll run processed for period ${payrollRun.periodStart.toISOString().split('T')[0]} to ${payrollRun.periodEnd.toISOString().split('T')[0]}`,
                payrollRunId: id,
                // HR-01 / T-P4.2 — the payroll run carries C4 money
                // (grossAmount/netAmount/totalDeductions and nested salary).
                // Redact those before persisting the audit diff so plaintext
                // C4 never lands in payroll_audit_logs.
                oldValues: JSON.stringify(redactC4(payrollRun)),
                newValues: JSON.stringify(redactC4(updatedRun))
            }
        });

        return updatedRun;
    } catch (error) {
        // Mark as failed if processing fails (scoped)
        await prisma.payrollRun.updateMany({
            where: withTenant(tenantId, { id }),
            data: { status: 'FAILED' }
        });
        throw error;
    }
};

// NOTE (HR-02 / T-P4.1): the legacy `calculateEmployeePay`, `calculatePeriodSalary`
// and `calculateTaxes` (hardcoded grossAmount*0.15 / *0.05, Float math) were
// REMOVED. Their behaviour now lives in the exported, pure, deterministic engine
// core above (buildPayslipFromInputs / calculatePeriodSalaryMinor /
// computeProgressiveTaxMinor) which processPayrollRun drives — the same code the
// golden-file regression test exercises (no mock copy of the logic).

const getBaseSalaryEarningTypeId = async (tenantId) => {
    let earningType = await prisma.payrollEarningType.findFirst({
        where: withTenant(tenantId, { code: 'BASE_SALARY' })
    });

    if (!earningType) {
        earningType = await prisma.payrollEarningType.create({
            data: {
                tenantId: tenantId ?? null,
                code: 'BASE_SALARY',
                name: 'Base Salary',
                type: 'EARNING',
                isTaxable: true
            }
        });
    }

    return earningType.id;
};

const getOrCreateDeductionType = async (code, name, tenantId) => {
    let deductionType = await prisma.payrollDeductionType.findFirst({
        where: withTenant(tenantId, { code })
    });

    if (!deductionType) {
        deductionType = await prisma.payrollDeductionType.create({
            data: {
                tenantId: tenantId ?? null,
                code,
                name,
                type: 'DEDUCTION'
            }
        });
    }

    return deductionType.id;
};

// HR-02 / T-P4.1 — APPROVAL GATE with separation of duties.
//
// A COMPLETED run must be APPROVED by a human who is DISTINCT from the employee
// that processed it before it can be FINALIZED. approvePayrollRun records the
// approver (must differ from processedBy — no self-approval) and moves the run
// to APPROVED. finalizePayrollRun then requires status===APPROVED with a
// recorded approver. The check compares integer employee ids.
export const approvePayrollRun = async (id, approverId, tenantId) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw new Error('Payroll run not found');

  if (payrollRun.status !== 'COMPLETED') {
    throw new Error('Only COMPLETED payroll runs can be approved');
  }

  const approver = toInt(approverId);
  if (approver === null) {
    throw new Error('HR-2010 approver id is required to approve a payroll run');
  }

  // Separation of duties: the approver MUST differ from the processor.
  if (payrollRun.processedBy != null && approver === payrollRun.processedBy) {
    throw new Error('HR-2011 self-approval forbidden: the approver must be distinct from the processor (same employee)');
  }

  await prisma.payrollRun.updateMany({
    where: withTenant(tenantId, { id }),
    data: { status: 'APPROVED', approvedBy: approver, approvedAt: new Date() }
  });

  await prisma.payrollAuditLog.create({
    data: {
      tenantId: tenantId ?? null,
      action: 'PAYROLL_APPROVED',
      // The approver id is recorded in approvedBy on the run; we keep it out of
      // the audit row's employeeId FK column (which references Employee) so the
      // audit write never couples to whether the actor is a payroll Employee.
      details: `Payroll run approved by employee ${approver} (processor was ${payrollRun.processedBy ?? 'unknown'})`,
      payrollRunId: id
    }
  });

  await logAction({
    employeeId: approver,
    type: 'Update',
    module: 'Payroll Run',
    result: 'SUCCESS',
    notes: `Payroll run "${id}" approved`
  });

  return getPayrollRunById(id, tenantId);
};

export const finalizePayrollRun = async (id, updatedBy, tenantId, ctx = {}) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw new Error('Payroll run not found');

  // X-07 — If-Match / 412 optimistic concurrency (opt-in via ctx.ifMatch). A
  // finalize racing a concurrent re-process/approve is rejected, not clobbered.
  assertIfMatch(ctx.ifMatch, payrollRun);

  // Approval gate: a run is only finalizable once it has been APPROVED by a
  // distinct approver. A COMPLETED-but-unapproved run is blocked here.
  if (payrollRun.status !== 'APPROVED') {
    throw new Error('HR-2012 payroll run requires approval before it can be finalized');
  }
  if (payrollRun.approvedBy == null) {
    throw new Error('HR-2012 payroll run requires approval before it can be finalized');
  }
  // Defence in depth: re-assert separation of duties at finalize time too, in
  // case the approval row was tampered with.
  if (payrollRun.processedBy != null && payrollRun.approvedBy === payrollRun.processedBy) {
    throw new Error('HR-2011 self-approval forbidden: the approver must be distinct from the processor');
  }

  // M1-HR: the payslip + run FINALIZED flips, the audit row, and the
  // hr.payroll.run_finalized.v1 outbox event commit or roll back together
  // (outbox-on-write, validate-before-write). The event is ids-only +
  // tenant-scoped from the run's verified tenant.
  await prisma.$transaction(async (tx) => {
    await tx.payrollPayslip.updateMany({
      where: withTenant(tenantId, { payrollRunId: id }),
      data: { status: 'FINALIZED' }
    });

    // HR-PAYSLIPALERT-02: gather the affected employees' ids (ids-only, no PII)
    // in the SAME tx/tenant scope so the run_finalized event carries the
    // recipient list the notification-hub mapper fans "payslip ready" out to.
    // employeeCount is derived from the distinct id list to stay consistent.
    const payslips = await tx.payrollPayslip.findMany({
      where: withTenant(tenantId, { payrollRunId: id }),
      select: { employeeId: true }
    });
    const employeeIds = [...new Set(payslips.map((p) => p.employeeId))];
    const employeeCount = employeeIds.length;

    // Move the run itself to FINALIZED so it is past the approval gate and can no
    // longer be re-processed (PROCESSABLE_STATUSES excludes FINALIZED).
    await tx.payrollRun.updateMany({
      where: withTenant(tenantId, { id }),
      data: { status: 'FINALIZED' }
    });

    await tx.payrollAuditLog.create({
      data: {
        tenantId: tenantId ?? null,
        action: 'PAYROLL_FINALIZED',
        details: `Payroll run finalized and ready for distribution (approved by ${payrollRun.approvedBy})`,
        payrollRunId: id
      }
    });

    const event = payrollRunFinalizedEvent(
      {
        id,
        tenantId: payrollRun.tenantId ?? tenantId,
        periodStart: payrollRun.periodStart ? new Date(payrollRun.periodStart).toISOString().slice(0, 10) : null,
        periodEnd: payrollRun.periodEnd ? new Date(payrollRun.periodEnd).toISOString().slice(0, 10) : null,
        employeeCount,
        employeeIds,
      },
      { actorId: ctx.actorId ?? updatedBy, correlationId: ctx.correlationId }
    );
    if (event) await enqueueHrDomainEvent(tx, event);
  });

  await logAction({
    employeeId: toInt(updatedBy),
    type: "Update",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${id}" finalized successfully`
  });

  return getPayrollRunById(id, tenantId);
};
export const cancelPayrollRun = async (id, deletedBy, tenantId) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw new Error('Payroll run not found');

  if (payrollRun.status === 'COMPLETED') {
    throw new Error('Cannot cancel a completed payroll run');
  }

  await prisma.payrollPayslip.deleteMany({
    where: withTenant(tenantId, { payrollRunId: id })
  });

  // deleteMany (not delete) so the tenant predicate guards the destructive op:
  // a cross-tenant id deletes zero rows (we already verified ownership above).
  await prisma.payrollRun.deleteMany({
    where: withTenant(tenantId, { id })
  });

  await prisma.payrollAuditLog.create({
    data: {
      tenantId: tenantId ?? null,
      action: 'PAYROLL_CANCELLED',
      details: 'Payroll run cancelled',
      payrollRunId: id
    }
  });

  await logAction({
    employeeId: Number(deletedBy),
    type: "Delete",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${id}" cancelled and deleted`
  });
};


// Earning Type Operations
export const getEarningTypes = async (tenantId) => {
    return prisma.payrollEarningType.findMany({
        where: withTenant(tenantId, {}),
        orderBy: { name: 'asc' }
    });
};

export const createEarningType = async (data, createdBy, tenantId) => {
  const create = await prisma.payrollEarningType.create({ data: { ...data, tenantId: tenantId ?? null } });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Earning Type",
    result: "SUCCESS",
    notes: `Earning Type "${create.name}" created`
  });

  return create;
};


export const updateEarningType = async (id, data, updatedBy, tenantId) => {
  // Ownership check then scoped update; a cross-tenant id is not-found.
  const existing = await prisma.payrollEarningType.findFirst({ where: withTenant(tenantId, { id }) });
  if (!existing) throw new Error('Earning type not found');

  await prisma.payrollEarningType.updateMany({
    where: withTenant(tenantId, { id }),
    data
  });
  const update = await prisma.payrollEarningType.findFirst({ where: withTenant(tenantId, { id }) });

  await logAction({
    employeeId: Number(updatedBy),
    type: "Update",
    module: "Earning Type",
    result: "SUCCESS",
    notes: `Earning Type "${update.name}" updated`
  });

  return update;
};
// Deduction Type Operations
export const getDeductionTypes = async (tenantId) => {
    return prisma.payrollDeductionType.findMany({
        where: withTenant(tenantId, {}),
        orderBy: { name: 'asc' }
    });
};

export const createDeductionType = async (data, createdBy, tenantId) => {
  const create = await prisma.payrollDeductionType.create({ data: { ...data, tenantId: tenantId ?? null } });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Deduction Type",
    result: "SUCCESS",
    notes: `Deduction Type "${create.name}" created`
  });

  return create;
};

export const updateDeductionType = async (id, data, updatedBy, tenantId) => {
  const existing = await prisma.payrollDeductionType.findFirst({ where: withTenant(tenantId, { id }) });
  if (!existing) throw new Error('Deduction type not found');

  await prisma.payrollDeductionType.updateMany({
    where: withTenant(tenantId, { id }),
    data
  });
  const update = await prisma.payrollDeductionType.findFirst({ where: withTenant(tenantId, { id }) });

  await logAction({
    employeeId: Number(updatedBy),
    type: "Update",
    module: "Deduction Type",
    result: "SUCCESS",
    notes: `Deduction Type "${update.name}" updated`
  });

  return update;
};

// Employee Payroll Data Operations
export const getEmployeePayrollData = async (employeeId, tenantId) => {
    const [employmentTerms, assignments, bankDetails, payslips] = await Promise.all([
        prisma.employmentTerms.findMany({
            where: withTenant(tenantId, { employeeId }),
            orderBy: { effectiveFrom: 'desc' }
        }),
        prisma.payrollAssignment.findMany({
            where: withTenant(tenantId, { employeeId, isActive: true }),
            include: {
                earningType: true,
                deductionType: true
            }
        }),
        prisma.bankDetail.findMany({
            where: withTenant(tenantId, { employeeId })
        }),
        prisma.payrollPayslip.findMany({
            where: withTenant(tenantId, { employeeId }),
            include: {
                payrollRun: true,
                earnings: {
                    include: {
                        earningType: true
                    }
                },
                deductions: {
                    include: {
                        deductionType: true
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            take: 6 // Last 6 payslips
        })
    ]);

    return {
        employmentTerms,
        assignments,
        bankDetails,
        recentPayslips: payslips
    };
};


export const createEmploymentTerms = async (data, createdBy, tenantId) => {
  // strip the non-column `createdBy` the controller folds into the payload
  // (legacy shape) so the scoped create only persists real columns + tenantId.
  const { createdBy: _ignored, ...termsData } = data;
  const create = await prisma.employmentTerms.create({
    data: { ...termsData, tenantId: tenantId ?? null }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Employment Terms",
    result: "SUCCESS",
    notes: `Employment terms created for employee ID: ${create.employeeId || "N/A"}`
  });

  return create;
};

export const createPayrollAssignment = async (data, createdBy, tenantId) => {
  // strip the non-column `createdBy` the controller folds into the payload
  // (legacy shape) so the scoped create only persists real columns + tenantId.
  const { createdBy: _ignored, ...assignmentData } = data;
  const create = await prisma.payrollAssignment.create({
    data: { ...assignmentData, tenantId: tenantId ?? null },
    include: {
      earningType: true,
      deductionType: true
    }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Payroll Assignment",
    result: "SUCCESS",
    notes: `Payroll assignment created for employee ID: ${create.employeeId} (EarningType: ${create.earningTypeId || "N/A"}, DeductionType: ${create.deductionTypeId || "N/A"})`
  });

  return create;
};

// Payslip Operations
export const getPayslips = async ({ page, limit, payrollRunId, employeeId, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = parseInt(payrollRunId);
    if (employeeId) where.employeeId = parseInt(employeeId);
    const scoped = withTenant(tenantId, where);

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where: scoped,
            skip,
            take: parseInt(limit),
            orderBy: { created_at: 'desc' },
            include: {
                employee: {
                    select: { id: true, first_name: true, last_name: true, job_title: true }
                },
                payrollRun: true,
                earnings: {
                    include: {
                        earningType: true
                    }
                },
                deductions: {
                    include: {
                        deductionType: true
                    }
                }
            }
        }),
        prisma.payrollPayslip.count({ where: scoped })
    ]);

    return {
        payslips,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayslipById = async (id, tenantId) => {
    // findFirst so the tenant predicate applies: a cross-tenant payslip id
    // resolves to null → controller returns 404 (never another tenant's slip).
    return prisma.payrollPayslip.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    job_title: true
                }
            },
            payrollRun: true,
            earnings: {
                include: {
                    earningType: true
                }
            },
            deductions: {
                include: {
                    deductionType: true
                }
            }
        }
    });
};

export const distributePayslip = async (id, createdBy, tenantId) => {
  const payslip = await prisma.payrollPayslip.findFirst({
    where: withTenant(tenantId, { id })
  });

  if (!payslip) {
    throw new Error("Payslip not found");
  }

  if (payslip.status !== "FINALIZED") {
    throw new Error("Only finalized payslips can be distributed");
  }

  await prisma.payrollPayslip.updateMany({
    where: withTenant(tenantId, { id }),
    data: {
      status: "DISTRIBUTED",
      distributedAt: new Date()
    }
  });
  const updatedPayslip = await prisma.payrollPayslip.findFirst({ where: withTenant(tenantId, { id }) });

  // ✅ Centralized audit log entry
  await logAction({
    employeeId: Number(createdBy),
    type: "Distribute",
    module: "Payslip",
    result: "SUCCESS",
    notes: `Payslip (ID: ${id}) distributed to employee ID: ${payslip.employeeId}`
  });

  return updatedPayslip;
};

export const getEmployeePayslips = async (employeeId, { page, limit, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = withTenant(tenantId, { employeeId });

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: { created_at: 'desc' },
            include: {
                payrollRun: true,
                earnings: {
                    include: {
                        earningType: true
                    }
                },
                deductions: {
                    include: {
                        deductionType: true
                    }
                }
            }
        }),
        prisma.payrollPayslip.count({ where })
    ]);

    return {
        payslips,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

// Tax Rate Operations
export const getTaxRates = async (countryCode, tenantId) => {
    const where = withTenant(tenantId, countryCode ? { countryCode } : {});
    return prisma.taxRate.findMany({
        where,
        orderBy: { bracketMin: 'asc' }
    });
};

export const createTaxRate = async (data, createdBy, tenantId) => {
  const create = await prisma.taxRate.create({
    data: { ...data, tenantId: tenantId ?? null }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Tax Rate",
    result: "SUCCESS",
    notes: `Tax rate for country "${create.countryCode}" and bracket "${create.bracketMin} - ${create.bracketMax}" created successfully`
  });

  return create;
};
// Audit Log Operations
export const getAuditLogs = async ({ page, limit, payrollRunId, payslipId, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = parseInt(payrollRunId);
    if (payslipId) where.payslipId = parseInt(payslipId);
    const scoped = withTenant(tenantId, where);

    const [auditLogs, total] = await Promise.all([
        prisma.payrollAuditLog.findMany({
            where: scoped,
            skip,
            take: parseInt(limit),
            orderBy: { created_at: 'desc' },
            include: {
                payrollRun: {
                    select: { id: true, periodStart: true, periodEnd: true }
                },
                payslip: {
                    select: { id: true, employeeId: true }
                },
                employee: {
                    select: { id: true, first_name: true, last_name: true }
                }
            }
        }),
        prisma.payrollAuditLog.count({ where: scoped })
    ]);

    return {
        auditLogs,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export default {
    getPayrollRuns,
    getPayrollRunById,
    createPayrollRun,
    processPayrollRun,
    approvePayrollRun,
    finalizePayrollRun,
    cancelPayrollRun,
    getEarningTypes,
    createEarningType,
    updateEarningType,
    getDeductionTypes,
    createDeductionType,
    updateDeductionType,
    getEmployeePayrollData,
    createEmploymentTerms,
    createPayrollAssignment,
    getPayslips,
    getPayslipById,
    distributePayslip,
    getEmployeePayslips,
    getTaxRates,
    createTaxRate,
    getAuditLogs
};
