// HR-IMPORT-01 — match people by identity, not by how their name is spelled.
//
// Every reconciliation against HR's workbook this month matched employees by
// fuzzy token overlap, and it needed a human at every turn:
//
//   "G Rasool"     matched both Ghulam Rasool and Abdul Rasool Junejo
//   "M. Yaseen"    is two different people, in Homenet and BOC
//   "Moeez"/"Moeez 2"  two columns, one of them somebody else
//   "Hasaam", "Shokat", "Jafri", "Jamshed"  matched nobody, because the
//                  stop-word list ate the only distinguishing token
//
// I resolved those by reading tenants and shift times and deciding. That is not
// a system, and the failure mode is silent: a wrong match moves one person's
// attendance onto another person's payslip.
//
// So identity is EXPLICIT and ordered, and never guessed:
//   1. employee_code — unambiguous when the sheet carries it
//   2. sheet_alias   — the label this employee is known by in the workbook
//   3. exact name    — case- and space-insensitive, nothing else
// Anything else is reported as unmatched or ambiguous for a human to map ONCE,
// after which it is a lookup forever.
import { describe, it, expect } from '@jest/globals';
import { resolveEmployeeByLabel } from '../../src/lib/employeeIdentity.js';

const ROSTER = [
    { id: 1, employee_code: 'EMP162', employee_name: 'Ghulam Rasool', sheet_alias: 'G Rasool' },
    { id: 2, employee_code: 'EMP158', employee_name: 'Abdul Rasool Junejo', sheet_alias: 'Abdul Rasool' },
    { id: 3, employee_code: 'EMP187', employee_name: 'M. Yaseen', sheet_alias: 'Yaseen' },
    { id: 4, employee_code: 'EMP156', employee_name: 'M. Yaseen', sheet_alias: null },
    { id: 5, employee_code: 'EMP182', employee_name: 'Hassam', sheet_alias: 'Hasaam' },
];

const find = (label) => resolveEmployeeByLabel(label, ROSTER);

describe('HR-IMPORT-01 stable identity for sheet imports', () => {
    it('matches on employee code first', () => {
        expect(find('EMP162')).toMatchObject({ matched: true, employeeId: 1 });
    });

    it('matches the alias the workbook actually uses', () => {
        // "G Rasool" fuzzily matched Abdul Rasool Junejo too. The alias settles
        // it without any scoring.
        expect(find('G Rasool')).toMatchObject({ matched: true, employeeId: 1 });
        expect(find('Abdul Rasool')).toMatchObject({ matched: true, employeeId: 2 });
    });

    it('matches an exact name regardless of case and spacing', () => {
        expect(find('  hassam ')).toMatchObject({ matched: true, employeeId: 5 });
    });

    it('reports AMBIGUOUS rather than picking one of two real people', () => {
        // Two M. Yaseen exist. Guessing puts one person's attendance on the
        // other's payslip, silently.
        const r = find('M. Yaseen');

        expect(r.matched).toBe(false);
        expect(r.reason).toBe('ambiguous');
        expect(r.candidates).toHaveLength(2);
    });

    it('an alias beats a name collision', () => {
        // Yaseen (EMP187) carries an alias, so the label the sheet uses for him
        // resolves even though two people share the name.
        expect(find('Yaseen')).toMatchObject({ matched: true, employeeId: 3 });
    });

    it('reports UNMATCHED rather than finding a near-enough person', () => {
        const r = find('Jamshed');

        expect(r.matched).toBe(false);
        expect(r.reason).toBe('unmatched');
    });

    it('never falls back to partial or token matching', () => {
        // "Rasool" overlaps two names. The old matcher scored it; this one
        // refuses, because a plausible guess is what caused the problem.
        expect(find('Rasool').matched).toBe(false);
    });

    it('handles an empty or missing label without throwing', () => {
        expect(find('').matched).toBe(false);
        expect(find(null).matched).toBe(false);
        expect(find(undefined).matched).toBe(false);
    });

    it('is case-insensitive on the alias too', () => {
        expect(find('g rasool')).toMatchObject({ matched: true, employeeId: 1 });
    });
});
