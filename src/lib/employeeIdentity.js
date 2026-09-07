// src/lib/employeeIdentity.js
//
// Who a label in a spreadsheet refers to (HR-IMPORT-01).
//
// Reconciling against HR's workbook this month matched people by fuzzy token
// overlap, and it needed a human at every turn: "G Rasool" also matched Abdul
// Rasool Junejo; "M. Yaseen" is two different people in two tenants;
// "Moeez"/"Moeez 2" are two columns, one of them somebody else; and "Hasaam",
// "Shokat", "Jafri" and "Jamshed" matched nobody because the stop-word list ate
// the only distinguishing token.
//
// Each of those was settled by hand, by reading tenants and shift times. That
// is not a system, and its failure mode is silent — a wrong match moves one
// person's attendance onto another person's payslip, and nothing complains.
//
// So matching is EXACT and ordered. No scoring, no partial credit:
//   1. employee_code   unambiguous, when the sheet carries it
//   2. sheet_alias     the label the workbook uses for this employee
//   3. exact name      case- and space-insensitive, and nothing looser
//
// Anything else comes back unmatched or ambiguous, for a human to map ONCE.
// After that it is a lookup, forever. A refusal is cheap; a plausible wrong
// answer is what cost us the month.

const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Resolve a spreadsheet label to exactly one employee.
 *
 * @param {string} label
 * @param {Array<{id:number, employee_code?:string, employee_name?:string, sheet_alias?:string}>} employees
 * @returns {{matched: boolean, employeeId?: number, via?: string, reason?: string,
 *            candidates?: Array<{employeeId:number, employeeCode:string, name:string}>}}
 */
export function resolveEmployeeByLabel(label, employees = []) {
  const key = norm(label);
  if (!key) return { matched: false, reason: "empty" };

  const describe = (list) => list.map((e) => ({
    employeeId: e.id,
    employeeCode: e.employee_code ?? null,
    name: e.employee_name ?? null,
  }));

  // Each rung is tried in turn, and a rung that finds MORE than one match stops
  // the search — falling through to a looser rule after an ambiguous exact one
  // would be how a guess sneaks back in.
  for (const [via, of] of [
    ["employee_code", (e) => e.employee_code],
    ["sheet_alias", (e) => e.sheet_alias],
    ["employee_name", (e) => e.employee_name],
  ]) {
    const hits = employees.filter((e) => of(e) && norm(of(e)) === key);
    if (hits.length === 1) return { matched: true, employeeId: hits[0].id, via };
    if (hits.length > 1) {
      return { matched: false, reason: "ambiguous", via, candidates: describe(hits) };
    }
  }

  return { matched: false, reason: "unmatched" };
}

/**
 * Resolve a whole sheet's labels, keeping the failures rather than dropping
 * them — an unmatched column is somebody whose month is about to go missing,
 * which is exactly what must not pass quietly.
 */
export function resolveLabels(labels, employees = []) {
  const matched = new Map();
  const problems = [];
  for (const label of labels) {
    const r = resolveEmployeeByLabel(label, employees);
    if (r.matched) matched.set(label, r.employeeId);
    else problems.push({ label, ...r });
  }
  return { matched, problems };
}
