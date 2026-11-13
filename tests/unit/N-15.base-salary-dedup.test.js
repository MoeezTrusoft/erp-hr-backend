// N-15 — SALARY DEDUP GUARD: employment_terms.baseSalary already holds the
// contractual Basic (45% of package). Four tenants ALSO carried it as a BASIC
// earning assignment, and the engine paid both — salaries came out at 145% of
// package. Verified in production: Trusoft payslips showed 225,000 base +
// 225,000 BASIC assignment for Syed Qasim (500K package).
//
// The guard drops earning assignments whose type duplicates the base WHEN the
// employee has employment terms. HomeVision (terms-only, the correct pattern)
// is untouched; a tenant with no terms keeps its assignments.
import { describe, it, expect } from '@jest/globals';
import { dedupeBaseSalaryAssignments } from '../../src/services/payrollService.js';

const earning = (code) => ({ earningType: { id: 1, code, name: code }, amount: 225000, rate: null });
const deduction = () => ({ earningType: null, deductionType: { id: 5, code: 'ADVANCE_TAX' }, amount: 1000 });

describe('N-15 dedup of base-salary assignments', () => {
    it('drops a BASIC assignment when employment terms exist', () => {
        const employee = {
            employmentTerms: [{ id: 165, baseSalary: '225000' }],
            payrollAssignments: [earning('BASIC'), earning('HRA')],
        };
        expect(dedupeBaseSalaryAssignments(employee)).toBe(1);
        expect(employee.payrollAssignments.map((a) => a.earningType.code)).toEqual(['HRA']);
    });

    it('drops BASE_SALARY assignments too (legacy code)', () => {
        const employee = {
            employmentTerms: [{ id: 1, baseSalary: '100000' }],
            payrollAssignments: [earning('BASE_SALARY'), earning('MEDICAL')],
        };
        expect(dedupeBaseSalaryAssignments(employee)).toBe(1);
        expect(employee.payrollAssignments.map((a) => a.earningType.code)).toEqual(['MEDICAL']);
    });

    it('leaves HomeVision pattern untouched (terms, no base assignment)', () => {
        const employee = {
            employmentTerms: [{ id: 1, baseSalary: '283500' }],
            payrollAssignments: [earning('HOUSE_ALLOWANCE'), earning('TRANSPORT_ALLOWANCE')],
        };
        expect(dedupeBaseSalaryAssignments(employee)).toBe(0);
        expect(employee.payrollAssignments).toHaveLength(2);
    });

    it('leaves a tenant WITHOUT terms untouched (assignments are the only salary)', () => {
        const employee = {
            employmentTerms: [],
            payrollAssignments: [earning('BASIC'), earning('HRA')],
        };
        expect(dedupeBaseSalaryAssignments(employee)).toBe(0);
        expect(employee.payrollAssignments).toHaveLength(2);
    });

    it('never touches deduction assignments', () => {
        const employee = {
            employmentTerms: [{ id: 1, baseSalary: '100000' }],
            payrollAssignments: [deduction()],
        };
        expect(dedupeBaseSalaryAssignments(employee)).toBe(0);
        expect(employee.payrollAssignments).toHaveLength(1);
    });

    it('is safe on missing/empty shapes', () => {
        expect(dedupeBaseSalaryAssignments(null)).toBe(0);
        expect(dedupeBaseSalaryAssignments({})).toBe(0);
        expect(dedupeBaseSalaryAssignments({ employmentTerms: [{}], payrollAssignments: [] })).toBe(0);
    });
});
