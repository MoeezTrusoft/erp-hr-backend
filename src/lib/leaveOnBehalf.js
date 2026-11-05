// Issue 395 — leave requests raised ON BEHALF of an employee.
//
// Who may file for someone else, and on what basis:
//   • SELF      — the employee's own request, unchanged (self-service, no grant needed);
//   • HR        — the hr:leave POST grant: any employee of the caller's company;
//   • MANAGER   — the target's line manager (Employee.managerId === the caller's
//                 employee id), with NO write grant at all: the reporting line is
//                 the authorisation, exactly like the approval queue it feeds.
// Anything else is DENIED. The decision is a pure function of the two identities
// so it is unit-tested without the MCP stack; the tool resolves targetManagerId
// from the tenant-scoped employee row and passes it in.
export const RAISE_SELF = "SELF";
export const RAISE_HR = "HR";
export const RAISE_MANAGER = "MANAGER";
export const RAISE_DENIED = "DENIED";

export function mayRaiseLeaveFor({
  actingEmployeeId,
  canWriteOthers = false,
  targetEmployeeId,
  targetManagerId,
}) {
  const target = Number(targetEmployeeId);
  if (!Number.isInteger(target) || target <= 0) return RAISE_DENIED;
  const acting = Number(actingEmployeeId);
  const hasActor = Number.isInteger(acting) && acting > 0;
  if (hasActor && target === acting) return RAISE_SELF;
  // HR/admin: the company-wide write grant, as before.
  if (canWriteOthers) return RAISE_HR;
  // A line manager filing for a direct report. A request cannot be filed for
  // someone who manages themselves (that is just self-service).
  if (hasActor && targetManagerId != null && Number(targetManagerId) === acting)
    return RAISE_MANAGER;
  return RAISE_DENIED;
}

// The wordings the tool returns, so the client never has to guess why it refused.
export const RAISE_DENIED_MESSAGE =
  "Insufficient permissions: leave may only be raised for yourself, by your line manager, or by HR.";
