// F-07 / ARCH-00 P-02 / ARCH-05 §7.1 / ARCH-06 §9.1
// Employee-owned records use Employee.id only. RBAC User.id is never a fallback.
export function requireEmployeeActor(user) {
  const employeeId = Number(user?.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw Object.assign(new Error("Employee identity is required"), {
      status: 403,
      code: "HR-0701",
    });
  }
  return employeeId;
}
