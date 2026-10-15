import { consumeApproval } from '../approval/adapters.js';
import {
  ReplacementCommand,
  KtCommand,
  AssetCommand,
  AccessCommand,
  ClearanceCommand,
  InterviewCommand,
  SettlementCommand,
} from "@trusoft/contracts/employment";
import {
  run,
  fail,
  employee,
  permit,
  isHr,
  authorizedSeparation,
  managerOnly,
  approverOnly,
  task,
  createTask,
  updateTask,
  checkVersion,
  result,
  view,
  touch,
  event,
  json,
  ownsCode,
  includesActor,
} from "./base.js";
import { clearanceComplete, settlementTotal } from "./rules.js";

async function settlementInputs(tx, env, s) {
  const versions = {};
  for (const model of [
    "separationSourceSnapshot",
    "noticePeriodRecord",
    "assetHandoverItem",
    "clearanceItem",
  ]) {
    const rows = await tx[model].findMany({
      where: taskWhere(env, s),
      orderBy: { id: "asc" },
    });
    versions[model] = rows.map((r) => [r.id, r.version]);
  }
  return JSON.stringify(versions);
}
const taskWhere = (env, s) => ({ tenantId: env.tenantId, separationRef: s.id });
const ownerOnly = (env, t) => {
  if (!ownsCode(env, t.ownerCode))
    fail("Only the assigned owner may complete this task", 403);
};
const requireEvidence = (input) => {
  if (!input.evidenceRefs?.length) fail("Completion evidence is required");
};
const active = (s) => {
  if (!s.approvedAt) fail("Workstreams start after approval", 409);
};
const handoverWritable = (s) => {
  active(s);
  if (s.state === "CLEARANCE")
    fail("Handover is frozen after clearance starts", 409);
};
export async function generateDocument(tx, env, s, kind) {
  const template = s.policySnapshot.templates.find((t) => t.kind === kind);
  if (!template) fail("An approved document template is required", 409);
  const existing = await tx.separationDocument.findFirst({
    where: { ...taskWhere(env, s), key: kind },
  });
  if (existing) return existing;
  const values = {
    employeeCode: s.employeeCode,
    separationRef: s.id,
    lastWorkingAt: s.lastWorkingAt?.toISOString() || "",
    type: s.type,
  };
  const body = template.body.replace(
    /\{\{(employeeCode|separationRef|lastWorkingAt|type)\}\}/g,
    (_, key) => values[key],
  );
  const row = await createTask(
    tx,
    env,
    s,
    "separationDocument",
    kind,
    {
      kind,
      templateRef: template.approvedRef,
      body,
      mimeType: "text/plain",
      fileName: `${s.employeeCode}-${kind}.txt`,
    },
    s.policySnapshot.hrCodes[0],
  );
  return updateTask(tx, env, "separationDocument", row, {
    status: "COMPLETED",
  });
}
export async function generateWorkstreams(tx, env, s) {
  const p = s.policySnapshot,
    r = s.recommendation;
  await createTask(
    tx,
    env,
    s,
    "replacementPlan",
    "PLAN",
    {
      replacementCode: r.replacementCode || null,
      requisitionRef: r.requisitionRef || null,
      topics: r.topics,
      readinessSignedByCode: null,
    },
    r.interimOwnerCode,
  );
  for (let i = 0; i < r.topics.length; i++) {
    await createTask(
      tx,
      env,
      s,
      "replacementSession",
      `SESSION-${i}`,
      {
        title: r.topics[i],
        replacementCode: r.replacementCode || r.interimOwnerCode,
        acknowledgedByCode: null,
      },
      r.interimOwnerCode,
    );
    await createTask(
      tx,
      env,
      s,
      "knowledgeTransferItem",
      `KT-${i}`,
      {
        kind: "SYSTEM",
        title: r.topics[i],
        leaverAcknowledgedByCode: null,
        receiverAcknowledgedByCode: null,
      },
      r.interimOwnerCode,
    );
  }
  for (let i = 0; i < r.deliverables.length; i++)
    await createTask(
      tx,
      env,
      s,
      "knowledgeTransferItem",
      `DELIVERABLE-${i}`,
      {
        kind: "IN_FLIGHT_WORK",
        title: r.deliverables[i],
        leaverAcknowledgedByCode: null,
        receiverAcknowledgedByCode: null,
      },
      r.interimOwnerCode,
    );
  for (const system of ["SYSTEM", "VPN", "BUILDING"])
    await createTask(
      tx,
      env,
      s,
      "accessRevocationTask",
      system,
      { system },
      p.itOwnerCode,
    );
  for (const d of p.clearanceDepartments)
    await createTask(
      tx,
      env,
      s,
      "clearanceItem",
      d.departmentCode,
      { departmentCode: d.departmentCode },
      d.ownerCode,
    );
  await createTask(tx, env, s, "exitInterview", "INTERVIEW", {}, p.hrCodes[0]);
  await createTask(
    tx,
    env,
    s,
    "finalSettlementSheet",
    "SETTLEMENT",
    {},
    p.payrollOwnerCode,
  );
  for (const source of ["ASSETS", "PAYROLL", "INCENTIVES"])
    await tx.employmentDelivery.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: s.employeeCode,
        key: `source:${s.id}:${source}`,
        kind: `FETCH_${source}`,
        payload: { separationRef: s.id },
      },
    });
}
export async function assertHandoverComplete(tx, env, s) {
  const w = taskWhere(env, s),
    [plan, sessions, kt, assets, source] = await Promise.all([
      tx.replacementPlan.findFirst({ where: w }),
      tx.replacementSession.findMany({ where: w }),
      tx.knowledgeTransferItem.findMany({ where: w }),
      tx.assetHandoverItem.findMany({ where: w }),
      tx.separationSourceSnapshot.findFirst({ where: { ...w, key: "ASSETS" } }),
    ]);
  if (
    !plan?.payload.readinessSignedByCode ||
    !sessions.length ||
    sessions.some(
      (t) => t.status !== "COMPLETED" || !t.payload.acknowledgedByCode,
    )
  )
    fail("Replacement training and readiness sign-off are incomplete", 409);
  if (
    !kt.length ||
    kt.some(
      (t) =>
        t.status !== "COMPLETED" ||
        !t.payload.leaverAcknowledgedByCode ||
        !t.payload.receiverAcknowledgedByCode,
    )
  )
    fail(
      "Both leaver and receiver must acknowledge each knowledge-transfer item",
      409,
    );
  if (!source)
    fail(
      "A verified asset-custody snapshot is required, including an empty register",
      409,
    );
  if (assets.some((t) => t.status !== "COMPLETED"))
    fail("Resolve every asset before clearance", 409);
}
export async function assertExitComplete(tx, env, s) {
  await assertHandoverComplete(tx, env, s);
  const w = taskWhere(env, s),
    [clearances, assets, access, interview, settlement, notice] =
      await Promise.all([
        tx.clearanceItem.findMany({ where: w }),
        tx.assetHandoverItem.findMany({ where: w }),
        tx.accessRevocationTask.findMany({ where: w }),
        tx.exitInterview.findFirst({ where: w }),
        tx.finalSettlementSheet.findFirst({ where: w }),
        tx.noticePeriodRecord.findFirst({ where: w }),
      ]);
  if (!clearanceComplete(clearances, assets))
    fail("Every required department must sign clearance", 409);
  if (access.length !== 3 || access.some((t) => t.status !== "COMPLETED"))
    fail("Confirm system, VPN and building access revocation", 409);
  if (
    interview?.status !== "COMPLETED" ||
    settlement?.status !== "COMPLETED" ||
    !settlement.payload.payrollReceiptRef
  )
    fail(
      "Complete the HR interview and obtain payroll settlement handoff receipt",
      409,
    );
  if (notice?.payload.pending || notice?.payload.shortfallDays > 0)
    fail("Resolve notice shortfall or pending notice actions", 409);
  for (const c of clearances)
    for (const d of c.payload.dues || [])
      if (
        !settlement.payload.lines?.some(
          (l) =>
            l.sourceRef === c.id &&
            l.description === d.description &&
            l.amountMinor === d.amountMinor,
        )
      )
        fail("Include all clearance dues in the settlement", 409);
}
async function finishTask(tx, env, s, model, row, data, input, action) {
  const updated = await updateTask(tx, env, model, row, {
    ...data,
    evidenceRefs: input.evidenceRefs?.length
      ? input.evidenceRefs
      : row.evidenceRefs,
  });
  const parent = await touch(tx, env, s, action, action);
  return result(
    env,
    view(updated, model, {
      ...updated.payload,
      evidenceRefs: updated.evidenceRefs,
      separationVersion: parent.version,
    }),
  );
}
export const replacementAction = (raw) => {
  const input = ReplacementCommand.parse(raw);
  return run(
    input,
    "hr.separation.task",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true });
      handoverWritable(s);
      const model = [
        "SESSION",
        "COMPLETE_SESSION",
        "ACKNOWLEDGE_SESSION",
      ].includes(input.action)
        ? "replacementSession"
        : "replacementPlan";
      if (input.action === "SESSION") {
        await managerOnly(tx, env, s);
        if (
          input.taskVersion !== 0 ||
          !input.ownerCode ||
          !input.dueAt ||
          !input.title
        )
          fail("New sessions require owner, due date and title");
        const r = await createTask(
          tx,
          env,
          s,
          model,
          input.requestKey,
          {
            title: input.title,
            replacementCode: input.replacementCode || input.ownerCode,
          },
          input.ownerCode,
          input.dueAt,
        );
        await touch(tx, env, s, "SESSION_CREATED", input.title);
        return result(env, view(r, model));
      }
      const row = await task(tx, env, s, model, input);
      let payload = { ...row.payload },
        status = row.status;
      if (input.action === "PLAN") {
        await managerOnly(tx, env, s);
        if (input.replacementCode)
          await employee(tx, env.tenantId, input.replacementCode);
        if (!input.replacementCode && !input.requisitionRef)
          fail("Choose an employee code or recruitment requisition");
        if (
          input.requisitionRef &&
          !(await tx.jobRequisition.findFirst({
            where: { tenantId: env.tenantId, id: Number(input.requisitionRef) },
          }))
        )
          fail("Recruitment requisition not found", 404);
        payload = {
          ...payload,
          replacementCode: input.replacementCode || null,
          requisitionRef: input.requisitionRef || null,
          topics: input.topics || payload.topics,
          readinessSignedByCode: null,
        };
        status = "IN_PROGRESS";
      } else if (input.action === "COMPLETE_SESSION") {
        ownerOnly(env, row);
        requireEvidence(input);
        status = "AWAITING_ACK";
      } else if (input.action === "ACKNOWLEDGE_SESSION") {
        if (!ownsCode(env, row.payload.replacementCode))
          fail("The replacement must acknowledge personally", 403);
        if (row.status !== "AWAITING_ACK")
          fail("Complete the session first", 409);
        payload.acknowledgedByCode = env.who.employee_code;
        status = "COMPLETED";
      } else {
        await managerOnly(tx, env, s);
        requireEvidence(input);
        const sessions = await tx.replacementSession.findMany({
          where: taskWhere(env, s),
        });
        if (!sessions.length || sessions.some((t) => t.status !== "COMPLETED"))
          fail("Complete and acknowledge every session first", 409);
        payload.readinessSignedByCode = env.who.employee_code;
        status = "COMPLETED";
      }
      return finishTask(
        tx,
        env,
        s,
        model,
        row,
        { payload, status },
        input,
        input.action,
      );
    },
    "REPLACEMENT",
  );
};
export const ktAction = (raw) => {
  const input = KtCommand.parse(raw);
  return run(
    input,
    "hr.separation.task",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true });
      handoverWritable(s);
      if (input.action === "CREATE") {
        if (!isHr(env)) await managerOnly(tx, env, s);
        if (
          input.taskVersion !== 0 ||
          !input.ownerCode ||
          !input.dueAt ||
          !input.title ||
          !input.kind
        )
          fail("New KT items require kind, title, owner and due date");
        if (input.ownerCode === s.employeeCode)
          fail("The receiver must be another employee");
        const row = await createTask(
          tx,
          env,
          s,
          "knowledgeTransferItem",
          input.requestKey,
          { kind: input.kind, title: input.title },
          input.ownerCode,
          input.dueAt,
        );
        await touch(tx, env, s, "KT_CREATED", input.title);
        return result(env, view(row, "KNOWLEDGE_TRANSFER"));
      }
      const row = await task(tx, env, s, "knowledgeTransferItem", input),
        payload = { ...row.payload };
      let status = row.status;
      if (input.action === "COMPLETE") {
        if (![s.employeeCode, row.ownerCode].includes(env.who.employee_code))
          fail("Only the leaver or receiver may record completion", 403);
        requireEvidence(input);
        payload.completedAt = env.now.toISOString();
        payload.leaverAcknowledgedByCode = null;
        payload.receiverAcknowledgedByCode = null;
        status = "AWAITING_ACK";
      } else {
        if (!payload.completedAt)
          fail("Record completion evidence before acknowledging", 409);
        if (input.action === "ACK_LEAVER") {
          if (env.who.employee_code !== s.employeeCode)
            fail("Leaver acknowledgment must be personal", 403);
          payload.leaverAcknowledgedByCode = env.who.employee_code;
        } else {
          ownerOnly(env, row);
          payload.receiverAcknowledgedByCode = env.who.employee_code;
        }
        if (
          payload.leaverAcknowledgedByCode &&
          payload.receiverAcknowledgedByCode
        )
          status = "COMPLETED";
      }
      return finishTask(
        tx,
        env,
        s,
        "knowledgeTransferItem",
        row,
        { payload, status },
        input,
        input.action,
      );
    },
    "KT",
  );
};
export const assetAction = (raw) => {
  const input = AssetCommand.parse(raw);
  return run(
    input,
    "hr.separation.task",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true }),
        row = await task(tx, env, s, "assetHandoverItem", input);
      handoverWritable(s);
      requireEvidence(input);
      if (input.disposition === "RETURNED") ownerOnly(env, row);
      else {
        await approverOnly(tx, env, s);
        if (!input.approvalRef)
          fail("Approved write-off/recovery evidence is required");
      }
      if (
        input.disposition === "SETTLEMENT_RECOVERY" &&
        !(input.recoveryMinor > 0)
      )
        fail("Recovery amount is required");
      return finishTask(
        tx,
        env,
        s,
        "assetHandoverItem",
        row,
        {
          status: "COMPLETED",
          payload: {
            ...row.payload,
            disposition: input.disposition,
            condition: input.condition,
            serialVerified: true,
            approvalRef: input.approvalRef || null,
            approvedByCode: env.who.employee_code,
            recoveryMinor: input.recoveryMinor || 0,
          },
        },
        input,
        "ASSET_RESOLVED",
      );
    },
    "ASSET",
  );
};
export const accessAction = (raw) => {
  const input = AccessCommand.parse(raw);
  return run(
    input,
    "hr.separation.task",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true }),
        row = await task(tx, env, s, "accessRevocationTask", input);
      ownerOnly(env, row);
      requireEvidence(input);
      if (s.lastWorkingAt > env.now)
        fail("Access revocation is scheduled for the last working time", 409);
      if (row.payload.system !== input.system)
        fail("Access system does not match the task");
      return finishTask(
        tx,
        env,
        s,
        "accessRevocationTask",
        row,
        {
          status: "COMPLETED",
          payload: {
            ...row.payload,
            confirmationRef: input.confirmationRef,
            confirmedAt: env.now.toISOString(),
          },
        },
        input,
        "ACCESS_REVOKED",
      );
    },
    "ACCESS",
  );
};
export const clearanceAction = (raw) => {
  const input = ClearanceCommand.parse(raw);
  return run(
    input,
    "hr.separation.clear",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true });
      if (s.state !== "CLEARANCE") fail("Separation is not in clearance", 409);
      const department = s.policySnapshot.clearanceDepartments.find(
        (d) => d.departmentCode === input.departmentCode,
      );
      if (
        !includesActor(env, department?.signerCodes) ||
        env.who.employee_code === s.employeeCode
      )
        fail("Only an independent signer for this department may sign", 403);
      await assertHandoverComplete(tx, env, s);
      requireEvidence(input);
      const settlement = await tx.finalSettlementSheet.findFirst({
        where: taskWhere(env, s),
      });
      if (["HANDED_OFF", "COMPLETED"].includes(settlement?.status))
        fail("Payroll already holds the settlement; clearance is locked", 409);
      if (input.noDues !== !input.dues.length)
        fail("Choose no dues or supply itemized dues");
      const row = await task(tx, env, s, "clearanceItem", input);
      if (row.key !== input.departmentCode)
        fail("Department does not match the clearance task");
      const updated = await updateTask(tx, env, "clearanceItem", row, {
        status: "COMPLETED",
        payload: {
          ...row.payload,
          noDues: input.noDues,
          dues: input.dues,
          reason: input.reason,
          signedByCode: env.who.employee_code,
          signedAt: env.now.toISOString(),
        },
        evidenceRefs: input.evidenceRefs,
      });
      const parent = await touch(tx, env, s, "CLEARANCE_SIGNED", input.reason);
      if (
        (await tx.clearanceItem.count({
          where: { ...taskWhere(env, s), status: { not: "COMPLETED" } },
        })) === 0
      ) {
        await event(tx, env, parent, "hr.separation.clearance_completed.v1");
        await generateDocument(tx, env, parent, "CLEARANCE");
      }
      return result(
        env,
        view(updated, "CLEARANCE", {
          ...updated.payload,
          separationVersion: parent.version,
        }),
      );
    },
    "CLEARANCE",
  );
};
export const interviewAction = (raw) => {
  const input = InterviewCommand.parse(raw);
  return run(
    input,
    "hr.separation.verify",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true });
      active(s);
      if (env.who.employee_code === s.employeeCode)
        fail("An independent HR interviewer is required", 403);
      const row = await tx.exitInterview.findFirst({
        where: taskWhere(env, s),
      });
      checkVersion(row, input.taskVersion);
      return finishTask(
        tx,
        env,
        s,
        "exitInterview",
        row,
        {
          status: "COMPLETED",
          payload: {
            reasonTaxonomy: input.reasonTaxonomy,
            responses: input.responses,
            notes: input.notes,
          },
        },
        input,
        "INTERVIEW_RECORDED",
      );
    },
    "INTERVIEW",
  );
};
export const settlementAction = (raw) => {
  const input = SettlementCommand.parse(raw);
  return run(
    input,
    "hr.separation.settle",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true });
      active(s);
      if (s.employeeCode === env.who.employee_code)
        fail("Settlement requires an independent payroll officer", 403);
      const row = await tx.finalSettlementSheet.findFirst({
        where: taskWhere(env, s),
      });
      checkVersion(row, input.taskVersion);
      let payload = { ...row.payload },
        status = row.status;
      if (input.action === "PREPARE") {
        if (["HANDED_OFF", "COMPLETED"].includes(status))
          fail("Payroll already holds this settlement", 409);
        const source = await tx.separationSourceSnapshot.findFirst({
            where: { ...taskWhere(env, s), key: "PAYROLL" },
          }),
          clawback = await tx.separationSourceSnapshot.findFirst({
            where: { ...taskWhere(env, s), key: "INCENTIVES" },
          });
        if (!source || !clawback)
          fail(
            "Verified payroll and incentive source snapshots are required",
            409,
          );
        checkVersion(source, input.sourceVersion);
        const f = source.payload.financial,
          n = await tx.noticePeriodRecord.findFirst({
            where: taskWhere(env, s),
          }),
          p = s.policySnapshot.settlement;
        const lines = [];
        const add = (kind, amount, direction, sourceRef, description = kind) =>
          lines.push({
            kind,
            amountMinor: Math.round(amount),
            direction,
            sourceRef,
            description,
          });
        if (p.leaveEncashment)
          add(
            "LEAVE_ENCASHMENT",
            f.leaveDays * f.dailyRateMinor,
            "EARNING",
            source.payload.sourceRef,
          );
        if (p.noticeRecovery)
          add(
            "NOTICE_RECOVERY",
            (n.payload.buyoutDays + n.payload.shortfallDays) * f.dailyRateMinor,
            "DEDUCTION",
            n.id,
          );
        if (p.noticePay && s.type === "TERMINATION_WITHOUT_CAUSE")
          add(
            "NOTICE_PAY",
            Math.max(0, n.payload.requiredDays - n.payload.servedDays) *
              f.dailyRateMinor,
            "EARNING",
            n.id,
          );
        for (const [kind, key] of [
          ["LOAN", "loansMinor"],
          ["ADVANCE", "advancesMinor"],
          ["BOND", "bondsMinor"],
        ])
          add(kind, f[key], "DEDUCTION", source.payload.sourceRef);
        add(
          "INCENTIVE_CLAWBACK",
          clawback.payload.incentiveClawbacksMinor,
          "DEDUCTION",
          clawback.payload.sourceRef,
        );
        for (const a of await tx.assetHandoverItem.findMany({
          where: taskWhere(env, s),
        }))
          if (a.payload.disposition === "SETTLEMENT_RECOVERY")
            add("ASSET_RECOVERY", a.payload.recoveryMinor, "DEDUCTION", a.id);
        for (const c of await tx.clearanceItem.findMany({
          where: taskWhere(env, s),
        }))
          for (const due of c.payload.dues || [])
            add(
              "CLEARANCE_DUE",
              due.amountMinor,
              "DEDUCTION",
              c.id,
              due.description,
            );
        payload = {
          inputs: await settlementInputs(tx, env, s),
          currency: p.currency,
          minorUnits: p.minorUnits,
          lines,
          netMinor: settlementTotal(lines),
          sourceVersion: source.version,
          incentiveVersion: clawback.version,
          preparedByCode: env.who.employee_code,
        };
        status = "PREPARED";
      } else if (input.action === "HANDOFF") {
        if (status !== "PREPARED") fail("Prepare the settlement first", 409);
        if (payload.inputs !== (await settlementInputs(tx, env, s)))
          fail("Settlement inputs changed; prepare the settlement again", 409);
        const source = await tx.separationSourceSnapshot.findFirst({
          where: { ...taskWhere(env, s), key: "PAYROLL" },
        });
        if (
          source.version !== payload.sourceVersion ||
          input.sourceVersion !== source.version
        )
          fail("Payroll inputs changed; prepare the settlement again", 409);
        if (
          await tx.clearanceItem.count({
            where: { ...taskWhere(env, s), status: { not: "COMPLETED" } },
          })
        )
          fail(
            "Complete all departmental clearances before payroll handoff",
            409,
          );
        await consumeApproval(tx, env.tenantId, "SETTLEMENT", `${row.id}@${row.version}`);
        status = "HANDED_OFF";
        await event(tx, env, s, "hr.separation.settlement_ready.v1");
        await tx.employmentDelivery.upsert({
          where: {
            tenantId_key: {
              tenantId: env.tenantId,
              key: `settlement:${row.id}:${row.version}`,
            },
          },
          create: {
            tenantId: env.tenantId,
            employeeCode: s.employeeCode,
            key: `settlement:${row.id}:${row.version}`,
            kind: "PAYROLL_HANDOFF",
            payload: {
              separationRef: s.id,
              settlementRef: row.id,
              settlementVersion: row.version + 1,
            },
          },
          update: {},
        });
      } else {
        if (status !== "HANDED_OFF" || !input.receiptRef)
          fail(
            "A payroll receipt is required for the handed-off settlement",
            409,
          );
        if (!ownsCode(env, s.policySnapshot.payrollOwnerCode))
          fail(
            "Only the configured payroll owner can acknowledge receipt",
            403,
          );
        payload.payrollReceiptRef = input.receiptRef;
        status = "COMPLETED";
      }
      return finishTask(
        tx,
        env,
        s,
        "finalSettlementSheet",
        row,
        { payload, status },
        input,
        "SETTLEMENT_" + input.action,
      );
    },
    "SETTLEMENT",
  );
};
