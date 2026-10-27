import {
  SetupSave,
  SetupAction,
  SetupRead,
  SetupOverview,
  parseSetupData,
  IdentityCorrection,
} from "@trusoft/contracts/hr-company-setup";
import {
  command,
  transact,
  lockedRow,
  version,
  actions,
  audit,
  view,
  result,
  hash,
  seal,
  unseal,
  fail,
} from "./base.js";
import {
  active,
  source,
  employees,
  validateEmployee,
  readiness,
  overview,
} from "./sources.js";
import {
  companySetupSnapshot,
  applyCompanySetupIdentity,
} from "../rbac.client.js";
const editable = ["DRAFT", "RETURNED", "REJECTED"];
import {
  buildTracker,
  completionSnapshot,
  verifyCompletion,
} from "./tracker.js";

export async function saveSetup(raw) {
  const input = SetupSave.parse(raw);
  return command(input, "prepare", "SAVE", async (tx, env) => {
    const old = input.reviewRef
      ? await lockedRow(tx, env, input.reviewRef)
      : null;
    version(old, input);
    if (
      old &&
      (!editable.includes(old.state) ||
        old.kind !== input.kind ||
        old.employeeCode !== (input.employeeCode || null))
    )
      fail("This review cannot be edited", 409);
    const data = parseSetupData(input.kind, input.data),
      subjectKey =
        input.kind === "POLICY"
          ? "POLICY"
          : input.kind === "EMPLOYEE_SETUP"
            ? "EMPLOYEE:" + input.employeeCode
            : "IDENTITY:" + data.login;
    if (old && old.subjectKey !== subjectKey)
      fail("Create a new review to change the review subject", 409);
    const pending = await tx.hrSetupReview.findFirst({
      where: {
        tenantId: env.tenantId,
        subjectKey,
        state: { notIn: ["ACTIVE", "REJECTED"] },
        ...(old ? { id: { not: old.id } } : {}),
      },
    });
    if (pending)
      fail(
        "A review for this subject is already open. Continue that review.",
        409,
      );
    const snapshot = await source(
        tx,
        env,
        input.kind,
        input.employeeCode,
        data,
      ),
      payload = { data, evidenceRefs: input.evidenceRefs };
    const tracker =
      input.kind === "POLICY" ? await buildTracker(tx, env) : null;
    if (tracker) payload.completionSnapshot = completionSnapshot(tracker);
    const values = {
      payload: seal(payload),
      source: seal(snapshot),
      contentHash: hash({ payload, source: snapshot }),
      approvedByCode: null,
      approvedByUserId: null,
      approvedHash: null,
      approvedAt: null,
      failure: null,
      editorUserIds: [
        ...new Set([
          ...(old?.editorUserIds || []),
          ...(tracker?.editorUserIds || []),
          env.who.userId,
        ]),
      ],
    };
    const row = old
      ? await tx.hrSetupReview.update({
          where: { id: old.id },
          data: { ...values, version: { increment: 1 } },
        })
      : await tx.hrSetupReview.create({
          data: {
            ...values,
            tenantId: env.tenantId,
            kind: input.kind,
            subjectKey,
            employeeCode: input.employeeCode || null,
            preparedByCode: env.who.employee_code,
            preparedByUserId: env.who.userId,
          },
        });
    await audit(tx, env, row, "SAVE", input.reason);
    return result(env, { record: await view(tx, env, row) });
  });
}
async function validate(tx, env, row) {
  const payload = unseal(row.payload),
    data = parseSetupData(row.kind, payload.data, true);
  if (!payload.evidenceRefs.length)
    fail("At least one evidence reference is required");
  const snapshot = await source(tx, env, row.kind, row.employeeCode, data);
  if (snapshot.fingerprint !== unseal(row.source).fingerprint)
    fail(
      "Source records changed. Return the review to HR and refresh the draft before approval or activation.",
      409,
    );
  if (row.kind === "EMPLOYEE_SETUP") {
    const rows = await employees(tx, env, true),
      e = rows.find((e) => e.employee_code === row.employeeCode);
    validateEmployee(data, e, rows);
  }
  if (row.kind === "POLICY") {
    const remote = await companySetupSnapshot();
    const blockers = await readiness(tx, env, row, remote);
    if (blockers.length)
      fail("Company setup incomplete: " + blockers.join("; "), 409);
    await verifyCompletion(tx, env, payload.completionSnapshot, remote);
  }
  if (row.kind === "IDENTITY") {
    if (
      snapshot.affectedUserId === env.who.userId &&
      ["APPROVED", "ACTIVATING"].includes(row.state)
    )
      fail("You cannot apply a correction to your own login", 403);
    if (data.action === "LINK_EMPLOYEE") {
      if (
        !snapshot.account.member ||
        !snapshot.account.enabled ||
        !snapshot.target?.active
      )
        fail(
          "Linking requires an enabled company account and an active employee",
        );
      if (
        snapshot.target.userId &&
        snapshot.target.userId !== snapshot.account.userId
      )
        fail(
          "Target employee already has a different primary login. Resolve that account first.",
          409,
        );
      if (snapshot.linked.length > 1)
        fail(
          "Login owns multiple employee records. Resolve the duplicate links before reassignment.",
          409,
        );
    }
  }
  return { payload, data, snapshot };
}
async function applyEmployee(tx, env, row, data) {
  const rows = await employees(tx, env, true),
    e = rows.find((e) => e.employee_code === row.employeeCode),
    patch = { version: { increment: 1 } };
  validateEmployee(data, e, rows);
  if (data.category) patch.employeeCategory = data.category;
  if (data.gradeCode) {
    let grade = await tx.gradeLevel.findFirst({
      where: { tenantId: env.tenantId, name: data.gradeCode },
    });
    if (!grade)
      grade = await tx.gradeLevel.create({
        data: {
          tenantId: env.tenantId,
          name: data.gradeCode,
          description: data.gradeDescription || null,
        },
      });
    patch.gradeLevelId = grade.id;
  }
  if ("contractNoticeDays" in data)
    patch.contractNoticeDays = data.contractNoticeDays;
  if (data.managerCode)
    patch.managerId = rows.find((e) => e.employee_code === data.managerCode).id;
  if (data.statusResolution) {
    patch.status = data.statusResolution === "ACTIVE" ? "Active" : "Inactive";
    patch.employement_status = patch.status;
  }
  await tx.employee.update({ where: { id: e.id }, data: patch });
  await tx.assessmentIdentity.updateMany({
    where: { tenantId: env.tenantId, employeeCode: row.employeeCode },
    data: {
      ...(data.category ? { categoryCode: data.category } : {}),
      ...(data.managerCode ? { managerCode: data.managerCode } : {}),
      ...(data.statusResolution
        ? { active: data.statusResolution === "ACTIVE" }
        : {}),
    },
  });
}
async function activate(tx, env, row, input) {
  if (row.approvedHash !== row.contentHash)
    fail("Approval does not match the reviewed content", 409);
  const remote = await companySetupSnapshot();
  if (
    !remote.accounts.some(
      (a) =>
        a.userId === row.approvedByUserId &&
        a.member &&
        a.enabled &&
        a.permissions.includes("hr.setup.approve"),
    )
  )
    fail(
      "Management approval authority is no longer active. Return the review for a new decision.",
      409,
    );
  const { data, snapshot } = await validate(tx, env, row);
  if (row.kind === "POLICY") {
    const blockers = await readiness(tx, env, row, remote);
    if (blockers.length)
      fail("Activation blocked: " + blockers.join("; "), 409);
    await tx.$executeRaw`SELECT set_config('app.hr_setup_review',${row.id},true)`;
    await tx.separationPolicy.upsert({
      where: { tenantId: env.tenantId },
      create: {
        tenantId: env.tenantId,
        policy: data.policy,
        actorCode: env.who.employee_code,
        approvalReviewRef: row.id,
      },
      update: {
        policy: data.policy,
        actorCode: env.who.employee_code,
        approvalReviewRef: row.id,
        version: { increment: 1 },
      },
    });
  } else if (row.kind === "EMPLOYEE_SETUP")
    await applyEmployee(tx, env, row, data);
  else {
    const plan = IdentityCorrection.parse({
      reviewRef: row.id,
      digest: row.contentHash,
      tenantId: env.tenantId,
      action: data.action,
      login: data.login,
      employeeCode: data.employeeCode || null,
      hrEmployeeId: snapshot.target?.id || null,
      userId: snapshot.account.userId,
      sourceFingerprint: snapshot.account.fingerprint,
      preparedByCode: row.preparedByCode,
      preparedByUserId: row.preparedByUserId,
      approvedByCode: row.approvedByCode,
      approvedByUserId: row.approvedByUserId,
      actorUserId: env.who.userId,
      reason: input.reason,
    });
    row = await tx.hrSetupReview.update({
      where: { id: row.id },
      data: {
        state: "ACTIVATING",
        reservedEmployeeId: plan.hrEmployeeId,
        reservedUserId: plan.userId,
        activationPlan: seal(plan),
        version: { increment: 1 },
        failure: null,
      },
    });
    await audit(tx, env, row, "ACTIVATE_STARTED", input.reason);
    return row;
  }
  row = await tx.hrSetupReview.update({
    where: { id: row.id },
    data: {
      state: "ACTIVE",
      activatedAt: new Date(),
      version: { increment: 1 },
      failure: null,
    },
  });
  await audit(tx, env, row, "ACTIVATE", input.reason);
  return row;
}
export async function actSetup(raw) {
  const input = SetupAction.parse(raw),
    permission = {
      SUBMIT: "prepare",
      APPROVE: "approve",
      REJECT: "approve",
      REVERT: "approve",
      ACTIVATE: "activate",
      RETRY: "activate",
    }[input.action];
  const output = await command(
    input,
    permission,
    input.action,
    async (tx, env) => {
      let row = await lockedRow(tx, env, input.reviewRef);
      version(row, input);
      if (!actions(row, env).includes(input.action))
        fail("Action is not available to you at this stage", 403);
      if (input.action === "ACTIVATE")
        row = await activate(tx, env, row, input);
      else if (input.action === "RETRY")
        return result(env, { record: await view(tx, env, row) });
      else {
        if (["SUBMIT", "APPROVE"].includes(input.action))
          await validate(tx, env, row);
        const state = {
          SUBMIT: "MANAGEMENT",
          APPROVE: "APPROVED",
          REJECT: "REJECTED",
          REVERT: "RETURNED",
        }[input.action];
        row = await tx.hrSetupReview.update({
          where: { id: row.id },
          data: {
            state,
            version: { increment: 1 },
            ...(input.action === "APPROVE"
              ? {
                  approvedByCode: env.who.employee_code,
                  approvedByUserId: env.who.userId,
                  approvedAt: new Date(),
                  approvedHash: row.contentHash,
                }
              : {
                  approvedByCode: null,
                  approvedByUserId: null,
                  approvedAt: null,
                  approvedHash: null,
                }),
          },
        });
        await audit(tx, env, row, input.action, input.reason);
      }
      return result(env, { record: await view(tx, env, row) });
    },
  );
  if (
    ["ACTIVATE", "RETRY"].includes(input.action) &&
    output.record.state === "ACTIVATING"
  )
    return finishIdentity(input.reviewRef);
  return output;
}
// Both services commit durable receipts. A timeout leaves the approved plan
// reserved and retryable; an uncertain response never becomes a false success.
async function finishIdentity(ref) {
  const plan = await transact("activate", async (tx, env) => {
    const row = await lockedRow(tx, env, ref);
    if (row.state === "ACTIVE") return null;
    if (row.state !== "ACTIVATING")
      fail("Identity activation is not pending", 409);
    const p = unseal(row.activationPlan);
    if (p.userId === env.who.userId)
      fail("You cannot apply a correction to your own login", 403);
    return { ...p, actorUserId: env.who.userId };
  });
  if (plan) {
    try {
      await applyCompanySetupIdentity(plan);
      await transact("activate", async (tx, env) => {
        let row = await lockedRow(tx, env, ref);
        if (row.state === "ACTIVE") return;
        const saved = unseal(row.activationPlan);
        if (row.state !== "ACTIVATING" || saved.digest !== plan.digest)
          fail("Activation plan changed", 409);
        const rows = await employees(tx, env, true),
          snapshot = unseal(row.source);
        if (plan.action === "LINK_EMPLOYEE") {
          const e = rows.find((e) => e.id === plan.hrEmployeeId);
          if (
            !e ||
            !active(e) ||
            e.employee_code !== plan.employeeCode ||
            (e.userId && e.userId !== plan.userId)
          )
            fail("HR account ownership changed; reconciliation required", 409);
        }
        if (
          rows.some(
            (e) =>
              e.userId === plan.userId &&
              !snapshot.linked.some((s) => s.id === e.id),
          )
        )
          fail("HR account ownership changed; reconciliation required", 409);
        await tx.$executeRaw`SELECT set_config('app.hr_setup_review',${row.id},true)`;
        if (plan.action === "LINK_EMPLOYEE") {
          await tx.employee.updateMany({
            where: {
              tenant_id: env.tenantId,
              userId: plan.userId,
              id: { not: plan.hrEmployeeId },
            },
            data: { userId: null, version: { increment: 1 } },
          });
          await tx.employee.update({
            where: { id: plan.hrEmployeeId },
            data: { userId: plan.userId, version: { increment: 1 } },
          });
        } else
          await tx.employee.updateMany({
            where: { tenant_id: env.tenantId, userId: plan.userId },
            data: { userId: null, version: { increment: 1 } },
          });
        row = await tx.hrSetupReview.update({
          where: { id: row.id },
          data: {
            state: "ACTIVE",
            activatedAt: new Date(),
            version: { increment: 1 },
            failure: null,
          },
        });
        await audit(tx, env, row, "ACTIVATE_COMPLETED", plan.reason);
      });
    } catch {
      // Never expose RPC responses, service tokens or internal account IDs.
      await transact("activate", async (tx, env) => {
        let row = await lockedRow(tx, env, ref);
        if (row.state !== "ACTIVATING") return;
        row = await tx.hrSetupReview.update({
          where: { id: row.id },
          data: {
            failure:
              "Account correction is awaiting reconciliation. Retry safely; if it persists, ask an administrator to inspect this review.",
            version: { increment: 1 },
          },
        });
        await audit(
          tx,
          env,
          row,
          "ACTIVATION_PENDING",
          "Account or HR update has not been confirmed; approved plan retained for retry",
        );
      });
    }
  }
  return readSetup({ reviewRef: ref });
}
export async function readSetup(raw) {
  const input = SetupRead.parse(raw);
  return transact(null, async (tx, env) => {
    const row = await lockedRow(tx, env, input.reviewRef);
    let blockers = [];
    if (row.kind === "POLICY" && ["MANAGEMENT", "APPROVED"].includes(row.state))
      try {
        blockers = await readiness(tx, env, row, await companySetupSnapshot());
        try {
          await verifyCompletion(
            tx,
            env,
            unseal(row.payload).completionSnapshot,
          );
        } catch (e) {
          blockers.push(e.message);
        }
      } catch {
        blockers = [
          "Account service unavailable; activation readiness cannot be verified",
        ];
      }
    return result(env, { record: await view(tx, env, row, blockers) });
  });
}
export async function overviewSetup(raw) {
  const input = SetupOverview.parse(raw);
  return transact(null, async (tx, env) => {
    let remote;
    try {
      remote = await companySetupSnapshot();
    } catch {
      remote = null;
    }
    const rows = await tx.hrSetupReview.findMany({
      where: {
        tenantId: env.tenantId,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.state ? { state: input.state } : {}),
        ...(input.search
          ? {
              OR: [
                {
                  employeeCode: { contains: input.search, mode: "insensitive" },
                },
                { subjectKey: { contains: input.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { id: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: input.limit + 1,
    });
    const next = rows.length > input.limit ? rows[input.limit - 1].id : null;
    return result(env, {
      items: await Promise.all(
        rows.slice(0, input.limit).map((r) => view(tx, env, r, [], false)),
      ),
      nextCursor: next,
      overview: await overview(tx, env, remote),
    });
  });
}
