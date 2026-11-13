// A created leave request only reaches the Approval Centre once it is submitted.
// `submit` is injected (legacySubmit in production) so the rule is unit-tested
// without the approval stack.
//
// Issue 395 — a request raised ON BEHALF (HR, or the employee's line manager)
// now reaches the Approval Centre too. Before this it stayed PENDING with no
// approval row, so nobody could decide it: the HR Approve button refuses with
// HR-4201 ("open the Approval Centre") and the Approval Centre had nothing.
// The submission goes in as the EMPLOYEE's request with the on-behalf flag, so
// the filer stays on record and the route is the employee's own.
export async function fileLeaveForApproval({
  response,
  filedForSelf,
  onBehalf = false,
  raisedBy = null,
  reason,
  submit,
}) {
  const created = response?.data ?? response;
  let submission = { submittedForApproval: false };
  if (created?.id != null && (filedForSelf || onBehalf)) {
    try {
      await submit(
        "LEAVE",
        created.id,
        reason ||
          (onBehalf
            ? "Raised on behalf of the employee"
            : "Employee submitted the leave request"),
        // The options argument is passed only for an on-behalf raise, so the
        // self-service call keeps its original three-argument shape.
        ...(onBehalf ? [{ onBehalf: true, managerMayFile: true }] : []),
      );
      submission = {
        submittedForApproval: true,
        ...(onBehalf ? { raisedOnBehalf: true, raisedBy } : {}),
      };
    } catch (error) {
      submission = { submittedForApproval: false, submitNote: error.message };
    }
  }
  if (!created || typeof created !== "object") return response;
  return response?.data
    ? { ...response, data: { ...created, ...submission } }
    : { ...created, ...submission };
}
