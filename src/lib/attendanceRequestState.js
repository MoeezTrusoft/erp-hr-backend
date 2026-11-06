// TS-REQUEST-CLOSED-01 (2026-11-06) — who ended this request?
//
// A legacy form can be REJECTED without any approver decision behind it: the
// rules engine re-evaluated the day and restated it (Rustam Khan, 5 Oct 2026:
// a case the system auto-rejected because approved leave covered the day and
// the day became ON_LEAVE). The Timesheet read model carries this so the screens
// say "Closed" instead of telling the employee that their manager disapproved a
// day they never worked. A genuine refusal always has a decision row.
export const isSystemClosedRequest = (status, decisions = []) =>
  String(status ?? "").toUpperCase() === "REJECTED" &&
  (decisions?.length ?? 0) === 0;
