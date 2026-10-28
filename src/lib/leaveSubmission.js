// A created leave request only reaches the Approval Centre once it is submitted.
// `submit` is injected (legacySubmit in production) so the rule is unit-tested
// without the approval stack.
export async function fileLeaveForApproval({ response, filedForSelf, reason, submit }) {
  const created = response?.data ?? response;
  let submission = { submittedForApproval: false };
  if (created?.id != null && filedForSelf) {
    try {
      await submit("LEAVE", created.id, reason || "Employee submitted the leave request");
      submission = { submittedForApproval: true };
    } catch (error) {
      submission = { submittedForApproval: false, submitNote: error.message };
    }
  }
  if (!created || typeof created !== "object") return response;
  return response?.data
    ? { ...response, data: { ...created, ...submission } }
    : { ...created, ...submission };
}
