// Recruitment Phase 7: the shared employee display-name lookup.
import { describe, it, expect, jest } from "@jest/globals";
import { employeeDisplayName, collectEmployeeIds, employeeNamesById, nameOf } from "../../../src/lib/employee-names.util.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("employee display names", () => {
    it("joins first and last name, else falls back to employee_name, else null", () => {
        expect(employeeDisplayName({ first_name: " Ayesha ", last_name: "Khan" })).toBe("Ayesha Khan");
        expect(employeeDisplayName({ first_name: "Ali", last_name: null })).toBe("Ali");
        expect(employeeDisplayName({ first_name: "", last_name: "", employee_name: "Sara Malik" })).toBe("Sara Malik");
        expect(employeeDisplayName({})).toBeNull();
        expect(employeeDisplayName(null)).toBeNull();
    });

    it("collects positive integer ids once, ignoring blanks and junk", () => {
        expect(collectEmployeeIds([3, "3", "7", null, undefined, 0, -1, "x", 2.5])).toEqual([3, 7]);
    });

    it("runs one tenant-scoped query and maps only the names that resolve", async () => {
        const findMany = jest.fn().mockResolvedValue([
            { id: 3, first_name: "Ayesha", last_name: "Khan", employee_name: null },
            { id: 7, first_name: null, last_name: null, employee_name: null },
        ]);
        const names = await employeeNamesById({ employee: { findMany } }, TENANT, [3, "7", 3, 9]);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0][0]).toEqual({
            where: { id: { in: [3, 7, 9] }, tenant_id: TENANT },
            select: { id: true, first_name: true, last_name: true, employee_name: true },
        });
        expect(nameOf(names, "3")).toBe("Ayesha Khan");
        expect(nameOf(names, 7)).toBeNull();
        expect(nameOf(names, 9)).toBeNull();
        expect(nameOf(names, null)).toBeNull();
    });

    it("skips the query when there are no ids or no tenant", async () => {
        const findMany = jest.fn();
        expect((await employeeNamesById({ employee: { findMany } }, TENANT, [null])).size).toBe(0);
        expect((await employeeNamesById({ employee: { findMany } }, null, [1])).size).toBe(0);
        expect(findMany).not.toHaveBeenCalled();
    });
});
