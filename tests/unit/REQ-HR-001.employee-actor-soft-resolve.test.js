// REQ-HR-001 — deactivating an employee must not require the CALLER to be one.
//
// hr_employee_status_update resolved its audit actor with requireEmployeeActor,
// which throws HR-0701 ("Employee identity is required") when the caller has no
// linked Employee record. Operator accounts (rbac_admin@test.com and friends)
// have employeeId: null, so every deactivate from the Employee Directory —
// single row and bulk — 403'd, with the FE having no documented field to add.
//
// Authorization for that tool is already decided by assertPermission; the actor
// is only written to Employee.updatedById. So the resolution is a SOFT resolve:
// record the actor when we can, write null when we cannot, never block.
//
// requireEmployeeActor keeps its old behaviour for self-service paths, where a
// missing employee identity really is fatal.
import { describe, it, expect } from '@jest/globals';
import { requireEmployeeActor, resolveEmployeeActor } from '../../src/lib/employeeActor.js';

// No `email` on these users, so neither helper reaches the DB fallback.
const RBAC_ONLY_ADMIN = { userId: 9, employeeId: null, isAdmin: true };
const RBAC_ONLY_USER = { userId: 42, employeeId: null, isAdmin: false };
const LINKED_EMPLOYEE = { userId: 7, employeeId: 151, isAdmin: false };

describe('REQ-HR-001: employee actor resolution', () => {
    it('resolveEmployeeActor returns null instead of throwing HR-0701', async () => {
        await expect(resolveEmployeeActor(RBAC_ONLY_USER)).resolves.toBeNull();
    });

    it('resolveEmployeeActor still returns the real employee id when there is one', async () => {
        await expect(resolveEmployeeActor(LINKED_EMPLOYEE)).resolves.toBe(151);
    });

    it('resolveEmployeeActor handles the admin-without-employee shape', async () => {
        await expect(resolveEmployeeActor(RBAC_ONLY_ADMIN)).resolves.toBeNull();
    });

    it('resolveEmployeeActor tolerates a missing user object', async () => {
        await expect(resolveEmployeeActor(undefined)).resolves.toBeNull();
    });

    it('requireEmployeeActor still throws HR-0701 for self-service callers', async () => {
        await expect(requireEmployeeActor(RBAC_ONLY_USER)).rejects.toMatchObject({
            status: 403,
            code: 'HR-0701',
        });
    });

    it('requireEmployeeActor still resolves a linked employee', async () => {
        await expect(requireEmployeeActor(LINKED_EMPLOYEE)).resolves.toBe(151);
    });
});
