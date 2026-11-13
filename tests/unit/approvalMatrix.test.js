import { describe, expect, it } from "@jest/globals";
import {
  buildRoute,
  levelActions,
  nextActionable,
  parseLevels,
  previousActionable,
} from "../../src/lib/approvalMatrix.js";

const named = (name, action, ids, extra = {}) => ({ name, action, approverMode: "NAMED", approverIds: ids, ...extra });
const codes = { 1: "EMP-HR", 2: "EMP-MGMT", 3: "EMP-FIN" };
const approvers = (l) => l.approverIds.map((id) => codes[id]);
const seal = (levels, over = {}) =>
  buildRoute({ kind: "PAYROLL", matrixVersion: 1, levels: parseLevels("PAYROLL", levels), initiator: "EMP-HR", subject: "EMP-HR", amount: 100, approvers, ...over });

describe("approval matrix rules", () => {
  it("defaults levels to required and returnable, and removes duplicate approvers", () => {
    const [l] = parseLevels("PAYROLL", [named("Management", "APPROVE", [2, 2])]);
    expect(l).toMatchObject({ required: true, canReject: true, canReturn: true, approverIds: [2], satisfiedByInitiator: false });
  });

  it("refuses unknown kinds, unknown fields and routes without a deciding last level", () => {
    expect(() => parseLevels("LEAVE", [named("M", "APPROVE", [2])])).toThrow(/No approval matrix/);
    expect(() => parseLevels("PAYROLL", [{ ...named("M", "APPROVE", [2]), extra: 1 }])).toThrow();
    expect(() => parseLevels("PAYROLL", [named("HR", "VERIFY", [1])])).toThrow(/must approve/);
    expect(() => parseLevels("PAYROLL", [named("A", "APPROVE", [2]), named("B", "APPROVE", [3])])).toThrow(/only the last/);
    expect(() => parseLevels("PAYROLL", [])).toThrow();
    expect(() => parseLevels("PAYROLL", Array.from({ length: 9 }, (_, i) => named(`L${i}`, i === 8 ? "APPROVE" : "VERIFY", [1])))).toThrow();
  });

  it("limits thresholds to optional payroll levels", () => {
    const optional = named("Finance", "VERIFY", [3], { required: false, thresholdAmount: 10 });
    expect(() => parseLevels("ATTENDANCE", [optional, named("M", "APPROVE", [2])])).toThrow(/payroll only/);
    expect(() => parseLevels("PAYROLL", [{ ...optional, required: true }, named("M", "APPROVE", [2])])).toThrow(/required level/);
    expect(parseLevels("PAYROLL", [optional, named("M", "APPROVE", [2])])).toHaveLength(2);
  });

  it("never lets the initiator or the subject approve, and lets the initiator satisfy a level", () => {
    const route = seal([named("HR", "VERIFY", [1], { satisfiedByInitiator: true }), named("Management", "APPROVE", [2, 1])]);
    expect(route.levels[0]).toMatchObject({ auto: true, engaged: true });
    expect(route.levels[1].approverCodes).toEqual(["EMP-MGMT"]);
    expect(nextActionable(route, 0)).toEqual({ index: 1, codes: ["EMP-MGMT"] });
  });

  it("lets HR satisfy a level when raising for an employee, but nobody verifies their own case", () => {
    const levels = parseLevels("ATTENDANCE", [named("HR", "VERIFY", [1, 3], { satisfiedByInitiator: true }), named("Management", "APPROVE", [2])]);
    const onBehalf = buildRoute({ kind: "ATTENDANCE", matrixVersion: 1, levels, initiator: "EMP-HR", subject: "EMP-STAFF", amount: 0, approvers });
    expect(onBehalf.levels[0].auto).toBe(true);
    // The employee raising their own case, even if they are listed on the level, is not the verifier.
    const own = buildRoute({ kind: "ATTENDANCE", matrixVersion: 1, levels, initiator: "EMP-FIN", subject: "EMP-FIN", amount: 0, approvers });
    expect(own.levels[0].auto).toBe(false);
    expect(own.levels[0].approverCodes).toEqual(["EMP-HR"]);
  });

  it("keeps a paused level in the route but skips it, without needing approvers or a manager", () => {
    const manager = (l) => (l.approverMode === "EMPLOYEE_MANAGER" ? [null] : approvers(l));
    const levels = parseLevels("ATTENDANCE", [
      { name: "Line manager", action: "RECOMMEND", approverMode: "EMPLOYEE_MANAGER", paused: true },
      named("Management", "APPROVE", [2]),
    ]);
    expect(levels[0].paused).toBe(true);
    const route = buildRoute({ kind: "ATTENDANCE", matrixVersion: 2, levels, initiator: "EMP-STAFF", subject: "EMP-STAFF", amount: 0, approvers: manager });
    expect(route.levels[0]).toMatchObject({ engaged: false, skipped: "PAUSED", paused: true, approverCodes: [] });
    expect(nextActionable(route, 0)).toEqual({ index: 1, codes: ["EMP-MGMT"] });
    // Un-paused with no manager: an optional level is skipped, a required one blocks the submission.
    const live = parseLevels("ATTENDANCE", [{ name: "Line manager", action: "RECOMMEND", approverMode: "EMPLOYEE_MANAGER", required: false }, named("Management", "APPROVE", [2])]);
    const noManager = buildRoute({ kind: "ATTENDANCE", matrixVersion: 2, levels: live, initiator: "EMP-STAFF", subject: "EMP-STAFF", amount: 0, approvers: manager });
    expect(noManager.levels[0].skipped).toBe("NO_APPROVER");
  });

  it("never pauses the deciding level", () => {
    expect(() => parseLevels("PAYROLL", [named("Management", "APPROVE", [2], { paused: true })])).toThrow(/cannot be paused/);
  });

  it("blocks a required level nobody can act on, and skips an optional one", () => {
    expect(() => seal([named("HR only", "VERIFY", [1]), named("Management", "APPROVE", [2])])).toThrow(/no active approver other than the initiator/);
    const route = seal([named("HR only", "VERIFY", [1], { required: false }), named("Management", "APPROVE", [2])]);
    expect(route.levels[0]).toMatchObject({ engaged: false, skipped: "NO_APPROVER" });
  });

  it("skips optional levels below their amount threshold", () => {
    const levels = [named("Finance", "VERIFY", [3], { required: false, thresholdAmount: 1000 }), named("Management", "APPROVE", [2])];
    expect(seal(levels, { amount: 999 }).levels[0].skipped).toBe("BELOW_THRESHOLD");
    expect(seal(levels, { amount: 1000 }).levels[0].engaged).toBe(true);
  });

  it("excludes people who already acted and fails loudly when a required level has nobody left", () => {
    const route = seal([named("Finance", "VERIFY", [3]), named("Management", "APPROVE", [2, 3])], { initiator: "EMP-HR", subject: "EMP-HR" });
    expect(nextActionable(route, 1, ["EMP-FIN"])).toEqual({ index: 1, codes: ["EMP-MGMT"] });
    expect(() => nextActionable(route, 1, ["EMP-FIN", "EMP-MGMT"])).toThrow(/already acted/);
  });

  it("finds the previous actionable level, skipping automatic and skipped ones", () => {
    const route = seal([
      named("HR", "VERIFY", [1], { satisfiedByInitiator: true }),
      named("Finance", "VERIFY", [3]),
      named("Management", "APPROVE", [2]),
    ]);
    expect(previousActionable(route, 2)).toBe(1);
    expect(previousActionable(route, 1)).toBeNull();
  });

  it("offers each level only the actions its settings allow", () => {
    expect(levelActions({ action: "VERIFY", canReject: true, canReturn: true })).toEqual(["VERIFY", "REJECT", "REVERT"]);
    expect(levelActions({ action: "APPROVE", canReject: false, canReturn: false })).toEqual(["APPROVE"]);
    expect(levelActions({ action: "RECOMMEND", canReject: false, canReturn: true })).toEqual(["RECOMMEND_APPROVAL", "REVERT"]);
    expect(levelActions({ action: "APPROVE", canReject: true, canReturn: true })).toEqual(["APPROVE", "REJECT", "REVERT"]);
  });
});

describe("self verification", () => {
  const selfLevels = () => parseLevels("ATTENDANCE", [named("HR", "VERIFY", [1], { allowSelf: true }), named("Management", "APPROVE", [2])]);
  const route = (initiator, subject) =>
    buildRoute({ kind: "ATTENDANCE", matrixVersion: 3, levels: selfLevels(), initiator, subject, amount: 0, approvers });

  it("counts the verifier raising their own case as the verification, then Management decides", () => {
    const r = route("EMP-HR", "EMP-HR");
    expect(r.levels[0]).toMatchObject({ auto: true, engaged: true, allowSelf: true });
    expect(r.levels[1].approverCodes).toEqual(["EMP-MGMT"]);
    expect(nextActionable(r, 0)).toEqual({ index: 1, codes: ["EMP-MGMT"] });
  });

  it("keeps the subject eligible when somebody else raised the case", () => {
    const r = route("EMP-FIN", "EMP-HR");
    expect(r.levels[0]).toMatchObject({ auto: false });
    expect(r.levels[0].approverCodes).toEqual(["EMP-HR"]);
  });

  it("is off by default, so nobody verifies their own case", () => {
    const levels = parseLevels("ATTENDANCE", [named("HR", "VERIFY", [1]), named("Management", "APPROVE", [2])]);
    expect(() => buildRoute({ kind: "ATTENDANCE", matrixVersion: 1, levels, initiator: "EMP-HR", subject: "EMP-HR", amount: 0, approvers })).toThrow(/no active approver/);
  });

  it("never lets the deciding level or a manager level allow self", () => {
    expect(() => parseLevels("ATTENDANCE", [named("M", "APPROVE", [2], { allowSelf: true })])).toThrow(/verification level/);
    expect(() => parseLevels("ATTENDANCE", [{ name: "Mgr", action: "VERIFY", approverMode: "EMPLOYEE_MANAGER", allowSelf: true }, named("M", "APPROVE", [2])])).toThrow(/named approvers/);
  });

  it("does not let the subject approve their own case even with self verification on", () => {
    expect(() =>
      buildRoute({ kind: "ATTENDANCE", matrixVersion: 3, levels: selfLevels(), initiator: "EMP-HR", subject: "EMP-MGMT", amount: 0, approvers }),
    ).toThrow(/no active approver other than the initiator/);
  });
});
