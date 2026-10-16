import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { getCtx } from "../../mcp/context.js";
import { actor, employee, fail } from "../separation/base.js";
import { hash, seal, unseal } from "../company-setup/base.js";
import { fileData } from "../company-setup/tracker.js";
import { encryptString, decryptString } from "../../lib/crypto.js";
import {
  ACCEPTANCE_TOOLS,
  AcceptanceResult,
  AcceptanceSetup,
  AcceptanceSlot,
} from "@trusoft/contracts/attendance-acceptance";
import {
  acceptanceMatrix,
  acceptanceBlockers,
} from "@trusoft/contracts/attendance-acceptance-rules";

const permits = (env, p) => env.ctx.permissions?.includes(p) === true;
const requireGrant = (env, p) => {
  if (!permits(env, p)) fail("Requires " + p, 403);
};
const editable = (row) =>
  ["DRAFT", "REJECTED", "SUSPENDED"].includes(row.state);
const freshData = () => ({
  setup: AcceptanceSetup.parse({}),
  runs: {},
  defects: [],
  evidenceIds: [],
  deviceBaseline: {},
});
export const acceptanceDeviceFingerprint = (d) =>
  hash({
    sn: d.sn,
    tenantId: d.tenantId,
    siteId: d.siteId,
    timeZone: d.timeZone,
    allowedTenantIds: d.allowedTenantIds,
    biometricPublicKey: d.biometricPublicKey,
    biometricSite: d.biometricSite,
    fingerprintPadLevel: d.fingerprintPadLevel,
    fingerprintPadValidated: d.fingerprintPadValidated,
  });
const emptyApprovals = {
  verifiedByCode: null,
  verifiedByUserId: null,
  verifiedHash: null,
  approvedByCode: null,
  approvedByUserId: null,
  approvedHash: null,
  approvedAt: null,
  activatedAt: null,
};
async function linked(tx, env, code) {
  const e = await employee(tx, env.tenantId, code);
  if (
    /inactive|terminated|exited|offboard|separated/i.test(
      `${e.status} ${e.employement_status}`,
    )
  )
    fail("Choose an active employee code");
  return e;
}
function actions(row, env) {
  const a = [],
    uid = env.who.userId;
  const independent =
    !row.editorUserIds.includes(uid) && row.createdByUserId !== uid;
  if (editable(row) && permits(env, "hr.setup.prepare")) {
    a.push("SAVE");
    if (row.createdByUserId === uid) a.push("SUBMIT");
  }
  if (
    editable(row) &&
    permits(env, "hr.setup.prepare") &&
    independent &&
    unseal(row.payload).setup.technicalCode === env.who.employee_code
  )
    a.push("ATTEST_TECHNICAL");
  if (
    row.state === "LINE_MANAGER" &&
    row.managerUserId === uid &&
    uid !== row.createdByUserId &&
    permits(env, "hr.approvals.manager")
  )
    a.push("RECOMMEND_APPROVAL", "RECOMMEND_REJECTION", "REVERT");
  if (
    row.state === "HR" &&
    permits(env, "hr.approvals.verify") &&
    independent &&
    uid !== row.managerUserId
  )
    a.push("VERIFY", "REVERT");
  if (
    ["MANAGEMENT", "APPROVED"].includes(row.state) &&
    permits(env, "hr.setup.approve") &&
    independent &&
    uid !== row.verifiedByUserId &&
    uid !== row.managerUserId
  )
    a.push(
      ...(row.state === "MANAGEMENT" ? ["APPROVE", "REJECT"] : []),
      "REVERT",
    );
  if (row.state === "APPROVED" && permits(env, "hr.setup.activate"))
    a.push("ACTIVATE");
  if (row.state === "ACTIVE" && permits(env, "hr.setup.activate"))
    a.push("SUSPEND");
  if (
    ["SUSPENDED", "REJECTED"].includes(row.state) &&
    permits(env, "hr.setup.prepare")
  )
    a.push("REOPEN");
  if (editable(row) && permits(env, "hr.approvals.verify"))
    a.push("CLOSE_DEFECT");
  return a;
}
async function evidence(tx, env, row) {
  const files = await tx.attendanceAcceptanceEvidence.findMany({
    where: { tenantId: env.tenantId, siteRef: row.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      runKey: true,
      payload: true,
      uploadedByCode: true,
      createdAt: true,
    },
  });
  return files.map((f) => ({
    evidenceRef: f.id,
    runKey: f.runKey,
    ...unseal(f.payload),
    uploadedByCode: f.uploadedByCode,
    createdAt: f.createdAt.toISOString(),
  }));
}
async function validateReferences(tx, env, row, data, refs) {
  if (new Set(refs).size !== refs.length)
    fail("Duplicate attachment reference");
  const files = await tx.attendanceAcceptanceEvidence.count({
    where: { tenantId: env.tenantId, siteRef: row.id, id: { in: refs } },
  });
  if (
    files !== refs.length ||
    refs.some((id) => !data.evidenceIds.includes(id))
  )
    fail("Evidence must belong to this site and company", 403);
}
async function deviceBlockers(tx, env, data) {
  const b = [],
    s = data.setup;
  const release = await tx.attendanceSetupRelease.findFirst({
    where: { tenantId: env.tenantId, effectiveFrom: { lte: new Date() } },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
  if (!release?.config?.settings?.sites?.some((x) => x.id === s.siteCode))
    b.push(
      "Select a site from the currently published attendance configuration",
    );
  for (const d of s.inventory.filter((x) => x.mode !== "DISABLED")) {
    const device = await tx.attendanceCaptureDevice.findFirst({
      where: { tenantId: env.tenantId, sn: d.sn },
    });
    if (!device) {
      b.push(d.sn + ": registered owner-company device required");
      continue;
    }
    if (device.siteId !== s.siteCode)
      b.push(d.sn + ": device site differs from selected ERP site");
    if (data.deviceBaseline[d.sn] !== acceptanceDeviceFingerprint(device))
      b.push(
        d.sn + ": device settings changed; return and save a new baseline",
      );
    if (
      d.kind === "SECUGEN" &&
      d.mode === "AUTOMATED" &&
      (!device.biometricPublicKey ||
        !device.fingerprintPadValidated ||
        device.fingerprintPadLevel <= 0)
    )
      b.push(
        d.sn + ": signed kiosk and validated nonzero fingerprint PAD required",
      );
    if (d.kind === "CAMERA" && !device.biometricPublicKey)
      b.push(d.sn + ": registered managed face kiosk required");
  }
  return b;
}
async function blockers(tx, env, data) {
  return [
    ...acceptanceBlockers(data),
    ...(await deviceBlockers(tx, env, data)),
  ];
}
async function view(tx, env, row, details = true) {
  const data = unseal(row.payload),
    matrix = acceptanceMatrix(data.setup);
  const counts = { NOT_RUN: 0, PASS: 0, FAIL: 0, BLOCKED: 0, NA: 0 };
  for (const t of matrix) counts[data.runs[t.runKey]?.outcome || "NOT_RUN"]++;
  const out = {
    siteRef: row.id,
    slot: row.slot,
    state: row.state,
    version: row.version,
    location: data.setup.location,
    siteCode: data.setup.siteCode,
    counts,
    total: matrix.length,
    openDefects: data.defects.filter((d) => d.state !== "CLOSED").length,
    actions: actions(row, env),
    createdByCode: row.createdByCode,
    managerCode: row.managerCode,
    technicalByCode:
      row.technicalHash === row.contentHash ? row.technicalByCode : null,
    verifiedByCode: row.verifiedByCode,
    approvedByCode: row.approvedByCode,
    approvedAt: row.approvedAt?.toISOString() || null,
    activatedAt: row.activatedAt?.toISOString() || null,
    contentHash: row.contentHash,
  };
  if (!details) return out;
  const audit = await tx.attendanceAcceptanceAudit.findMany({
    where: { tenantId: env.tenantId, siteRef: row.id },
    orderBy: { version: "asc" },
  });
  return {
    ...out,
    setup: data.setup,
    runs: matrix.map((t) => ({
      ...t,
      ...data.runs[t.runKey],
      outcome: data.runs[t.runKey]?.outcome || "NOT_RUN",
    })),
    defects: data.defects,
    attachments: await evidence(tx, env, row),
    blockers: await blockers(tx, env, data),
    history: audit.map((a) => {
      const entry = unseal(a.payload);
      return {
        action: a.action,
        version: a.version,
        actorCode: a.actorCode,
        at: a.createdAt.toISOString(),
        reason: entry.reason,
        hash: entry.contentHash,
      };
    }),
  };
}
async function persist(
  tx,
  env,
  row,
  data,
  action,
  reason,
  changes = {},
  edit = false,
) {
  const contentHash = hash(data);
  const values = {
    payload: row?.contentHash === contentHash ? row.payload : seal(data),
    contentHash,
    ...changes,
  };
  if (edit) {
    values.editorUserIds = [
      ...new Set([...(row?.editorUserIds || []), env.who.userId]),
    ];
    Object.assign(values, emptyApprovals, {
      state: "DRAFT",
      technicalByCode: null,
      technicalByUserId: null,
      technicalHash: null,
    });
  }
  const updated = row
    ? await tx.attendanceAcceptanceSite.update({
        where: { id: row.id, tenantId: env.tenantId },
        data: { ...values, version: { increment: 1 } },
      })
    : await tx.attendanceAcceptanceSite.create({
        data: {
          ...values,
          tenantId: env.tenantId,
          slot: env.slot,
          editorUserIds: [env.who.userId],
          createdByCode: env.who.employee_code,
          createdByUserId: env.who.userId,
        },
      });
  await tx.attendanceAcceptanceAudit.create({
    data: {
      tenantId: env.tenantId,
      siteRef: updated.id,
      version: updated.version,
      action,
      actorCode: env.who.employee_code,
      actorUserId: env.who.userId,
      payload: seal({
        reason,
        contentHash: updated.contentHash,
        state: updated.state,
        snapshot: data,
      }),
    },
  });
  return updated;
}
const output = (env, extra) =>
  AcceptanceResult.parse({
    actorCode: env.who.employee_code,
    permissions: env.ctx.permissions,
    ...extra,
  });
export async function acceptanceCommand(name, raw = {}) {
  const def = ACCEPTANCE_TOOLS[name];
  if (!def) fail("Unknown acceptance operation", 404);
  const input = def.input.parse(raw),
    ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user?.tenantId)
    fail("Verified company context required", 401);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const env = {
        ctx,
        tenantId: ctx.user.tenantId,
        who: await actor(tx, ctx),
        slot: input.slot,
      };
      requireGrant(env, "hr.setup.read");
      requireGrant(env, def.permission);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":attendance-acceptance"},0))`;
      const digest = hash({ name, input });
      if (input.requestKey) {
        const prior = await tx.hrSetupReceipt.findUnique({
          where: {
            tenantId_requestKey: {
              tenantId: env.tenantId,
              requestKey: input.requestKey,
            },
          },
        });
        if (prior) {
          if (prior.actorUserId !== env.who.userId || prior.digest !== digest)
            fail("Request key already used for another command", 409);
          return AcceptanceResult.parse(unseal(prior.result));
        }
      }
      let result;
      if (name.endsWith("_overview")) {
        const rows = await tx.attendanceAcceptanceSite.findMany({
          where: { tenantId: env.tenantId },
          orderBy: { slot: "asc" },
        });
        const employees = await tx.employee.findMany({
          where: { tenant_id: env.tenantId },
          select: {
            employee_code: true,
            status: true,
            employement_status: true,
          },
          orderBy: { employee_code: "asc" },
        });
        const devices = await tx.attendanceCaptureDevice.findMany({
          where: { tenantId: env.tenantId },
          select: {
            sn: true,
            name: true,
            siteId: true,
            active: true,
            acceptanceSiteRef: true,
            acceptanceMode: true,
          },
        });
        const release = await tx.attendanceSetupRelease.findFirst({
          where: { tenantId: env.tenantId, effectiveFrom: { lte: new Date() } },
          orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
        });
        result = output(env, {
          sites: await Promise.all(
            AcceptanceSlot.options.map(async (slot) => {
              const row = rows.find((r) => r.slot === slot);
              return row
                ? view(tx, env, row, false)
                : {
                    slot,
                    state: "NOT_STARTED",
                    version: 0,
                    counts: {
                      NOT_RUN: 56,
                      PASS: 0,
                      FAIL: 0,
                      BLOCKED: 0,
                      NA: 0,
                    },
                    total: 56,
                    openDefects: 0,
                    actions: permits(env, "hr.setup.prepare") ? ["SAVE"] : [],
                  };
            }),
          ),
          options: {
            employeeCodes: employees
              .filter(
                (e) =>
                  e.employee_code &&
                  !/inactive|terminated|exited|offboard|separated/i.test(
                    `${e.status} ${e.employement_status}`,
                  ),
              )
              .map((e) => e.employee_code),
            devices,
            sites: release?.config?.settings?.sites || [],
          },
        });
      } else if (name.endsWith("_evidence_read")) {
        const f = await tx.attendanceAcceptanceEvidence.findFirst({
          where: { id: input.evidenceRef, tenantId: env.tenantId },
        });
        if (!f) fail("Evidence not found in this company", 404);
        result = output(env, {
          evidence: {
            evidenceRef: f.id,
            ...unseal(f.payload),
            contentBase64: decryptString(f.content),
          },
        });
      } else {
        let row = await tx.attendanceAcceptanceSite.findUnique({
          where: {
            tenantId_slot: { tenantId: env.tenantId, slot: input.slot },
          },
        });
        if (name.endsWith("_read")) {
          if (!row) fail("Site acceptance has not been started", 404);
          result = output(env, { record: await view(tx, env, row) });
        } else {
          if ((row?.version || 0) !== input.expectedVersion)
            fail("Acceptance changed. Refresh before saving.", 409);
          let data = row ? unseal(row.payload) : freshData();
          const action = name.split("acceptance_")[1];
          if (action !== "action" && row && !editable(row))
            fail("Return the package to preparation before editing", 409);
          if (action === "save") {
            const s = input.setup;
            if (s.leadCode) await linked(tx, env, s.leadCode);
            if (s.technicalCode) await linked(tx, env, s.technicalCode);
            const other = await tx.attendanceAcceptanceSite.findMany({
              where: { tenantId: env.tenantId, slot: { not: input.slot } },
            });
            if (
              s.siteCode &&
              other.some((r) => unseal(r.payload).setup.siteCode === s.siteCode)
            )
              fail("This ERP site is already assigned to another slot");
            const baseline = {};
            for (const d of s.inventory) {
              const device = await tx.attendanceCaptureDevice.findFirst({
                where: { tenantId: env.tenantId, sn: d.sn },
              });
              if (!device)
                fail(
                  "Choose a registered device owned by this company: " + d.sn,
                );
              if (
                other.some((r) =>
                  unseal(r.payload).setup.inventory.some((i) => i.sn === d.sn),
                )
              )
                fail("Device is already assigned to another site acceptance");
              baseline[d.sn] = acceptanceDeviceFingerprint(device);
            }
            const changed =
              hash({
                inventory: s.inventory,
                baselineRef: s.baselineRef,
                siteCode: s.siteCode,
                targetsRef: s.targetsRef,
                baseline,
              }) !==
              hash({
                inventory: data.setup.inventory,
                baselineRef: data.setup.baselineRef,
                siteCode: data.setup.siteCode,
                targetsRef: data.setup.targetsRef,
                baseline: data.deviceBaseline,
              });
            data = {
              ...data,
              setup: s,
              deviceBaseline: baseline,
              runs: changed ? {} : data.runs,
            };
            row = await persist(
              tx,
              env,
              row,
              data,
              "SAVE_SETUP",
              input.reason,
              {},
              true,
            );
          } else {
            if (!row) fail("Save site setup first");
            if (action === "run_save") {
              if (!data.setup.targetsApproved || !data.setup.targetsRef)
                fail(
                  "Approve targets and record their reference before execution",
                );
              const r = input.run,
                t = acceptanceMatrix(data.setup).find(
                  (t) => t.runKey === r.runKey,
                );
              if (!t) fail("Unknown test or device for this site");
              if (r.outcome === "NA" && !t.allowNA)
                fail("Installed or mandatory test cannot be N/A");
              if (r.witnessCode) {
                await linked(tx, env, r.witnessCode);
                if (r.witnessCode === env.who.employee_code)
                  fail("Use an independent witness employee code");
              }
              if (
                ["PASS", "NA"].includes(r.outcome) &&
                (!r.observed ||
                  !r.witnessCode ||
                  (!r.evidenceRefs.length && !r.attachmentRefs.length))
              )
                fail(
                  "Completed result requires findings, independent witness and evidence",
                );
              if (
                r.outcome === "PASS" &&
                (!r.attempts || !r.metrics || !r.startedAt || !r.finishedAt)
              )
                fail(
                  "Passed tests require times, attempts and measured results",
                );
              if (
                r.startedAt &&
                r.finishedAt &&
                (r.finishedAt < r.startedAt ||
                  new Date(r.finishedAt) > new Date())
              )
                fail("Execution dates must be ordered and not in the future");
              await validateReferences(tx, env, row, data, r.attachmentRefs);
              if (
                r.defectRefs.some(
                  (id) => !data.defects.some((d) => d.id === id),
                )
              )
                fail("Link defects from this site only");
              if (
                ["FAIL", "BLOCKED"].includes(r.outcome) &&
                !r.defectRefs.some((id) =>
                  data.defects.some(
                    (d) =>
                      d.id === id &&
                      d.state === "OPEN" &&
                      d.runKey === r.runKey,
                  ),
                )
              )
                fail("Link an open defect for this failed or blocked test");
              data.runs[r.runKey] = {
                ...r,
                testerCode: env.who.employee_code,
                recordedAt: new Date().toISOString(),
              };
              row = await persist(
                tx,
                env,
                row,
                data,
                "SAVE_RESULT",
                input.reason,
                {},
                true,
              );
            } else if (action === "defect_save") {
              await linked(tx, env, input.ownerCode);
              await validateReferences(
                tx,
                env,
                row,
                data,
                input.attachmentRefs,
              );
              if (
                !acceptanceMatrix(data.setup).some(
                  (t) => t.runKey === input.runKey,
                )
              )
                fail("Choose a test from this site");
              const old = data.defects.find((d) => d.id === input.defectRef);
              if (input.defectRef && !old) fail("Defect not found", 404);
              if (
                old &&
                ["CRITICAL", "HIGH"].includes(old.severity) &&
                !["CRITICAL", "HIGH"].includes(input.severity)
              )
                fail(
                  "Critical/High findings require closure and cannot be downgraded",
                );
              const {
                requestKey: _key,
                expectedVersion: _version,
                reason: _reason,
                slot: _slot,
                defectRef: _ref,
                ...d
              } = input;
              const saved = {
                ...d,
                id: old?.id || randomUUID(),
                state: "OPEN",
                raisedByCode: old?.raisedByCode || env.who.employee_code,
                updatedAt: new Date().toISOString(),
              };
              data.defects = [
                ...data.defects.filter((d) => d.id !== saved.id),
                saved,
              ];
              row = await persist(
                tx,
                env,
                row,
                data,
                "SAVE_DEFECT",
                input.reason,
                {},
                true,
              );
            } else if (action === "evidence_upload") {
              if (data.evidenceIds.length >= 300)
                fail(
                  "Use controlled evidence references beyond 300 attachments per site",
                );
              if (
                input.runKey !== "SITE" &&
                !acceptanceMatrix(data.setup).some(
                  (t) => t.runKey === input.runKey,
                )
              )
                fail("Choose a current site test");
              const { contentBase64, ...metadata } = fileData(input);
              const f = await tx.attendanceAcceptanceEvidence.create({
                data: {
                  tenantId: env.tenantId,
                  siteRef: row.id,
                  runKey: input.runKey,
                  payload: seal(metadata),
                  content: encryptString(contentBase64),
                  uploadedByCode: env.who.employee_code,
                },
              });
              data.evidenceIds.push(f.id);
              row = await persist(
                tx,
                env,
                row,
                data,
                "UPLOAD_EVIDENCE",
                input.reason,
                {},
                true,
              );
            } else if (action === "action") {
              if (!actions(row, env).includes(input.action))
                fail("This action is not permitted at this stage", 403);
              const changes = {};
              if (
                [
                  "RECOMMEND_APPROVAL",
                  "RECOMMEND_REJECTION",
                  "VERIFY",
                  "APPROVE",
                  "ACTIVATE",
                ].includes(input.action)
              ) {
                const initiator = await linked(tx, env, row.createdByCode);
                const manager = await linked(tx, env, row.managerCode);
                if (
                  initiator.userId !== row.createdByUserId ||
                  initiator.managerId !== manager.id ||
                  manager.userId !== row.managerUserId
                )
                  fail(
                    "Reporting line or account link changed; return the package to the initiator and obtain a new recommendation",
                    409,
                  );
              }
              if (input.action === "ACTIVATE")
                await tx.$queryRaw`SELECT id FROM attendance_capture_devices WHERE "tenantId"=${env.tenantId}::uuid ORDER BY sn FOR UPDATE`;
              if (
                [
                  "ATTEST_TECHNICAL",
                  "SUBMIT",
                  "VERIFY",
                  "APPROVE",
                  "ACTIVATE",
                ].includes(input.action)
              ) {
                const b = await blockers(tx, env, data);
                if (b.length)
                  fail("Acceptance blocked: " + b.slice(0, 8).join("; "), 409);
              }
              if (input.action === "ATTEST_TECHNICAL")
                Object.assign(changes, {
                  technicalByCode: env.who.employee_code,
                  technicalByUserId: env.who.userId,
                  technicalHash: row.contentHash,
                });
              else if (input.action === "SUBMIT") {
                if (row.technicalHash !== row.contentHash)
                  fail(
                    "Independent technical attestation, including N/A decisions, is required before submission",
                    409,
                  );
                if (row.createdByUserId !== env.who.userId)
                  fail("The employee initiator must submit this package", 403);
                const manager = env.who.managerId
                  ? await tx.employee.findFirst({
                      where: { id: env.who.managerId, tenant_id: env.tenantId },
                    })
                  : null;
                if (
                  !manager?.userId ||
                  manager.employee_code !== data.setup.leadCode ||
                  manager.userId === env.who.userId
                )
                  fail(
                    "Site lead must be the initiator’s recorded line manager with an active account",
                  );
                await linked(tx, env, manager.employee_code);
                Object.assign(changes, emptyApprovals, {
                  state: "LINE_MANAGER",
                  managerCode: manager.employee_code,
                  managerUserId: manager.userId,
                });
              } else if (input.action.startsWith("RECOMMEND_"))
                changes.state = "HR";
              else if (input.action === "VERIFY")
                Object.assign(changes, {
                  state: "MANAGEMENT",
                  verifiedByCode: env.who.employee_code,
                  verifiedByUserId: env.who.userId,
                  verifiedHash: row.contentHash,
                });
              else if (input.action === "APPROVE")
                Object.assign(changes, {
                  state: "APPROVED",
                  approvedByCode: env.who.employee_code,
                  approvedByUserId: env.who.userId,
                  approvedHash: row.contentHash,
                  approvedAt: new Date(),
                });
              else if (input.action === "REJECT")
                Object.assign(changes, emptyApprovals, { state: "REJECTED" });
              else if (input.action === "REVERT")
                Object.assign(changes, emptyApprovals, {
                  state: ["MANAGEMENT", "APPROVED"].includes(row.state)
                    ? "HR"
                    : "DRAFT",
                });
              else if (input.action === "REOPEN")
                Object.assign(changes, emptyApprovals, { state: "DRAFT" });
              else if (input.action === "SUSPEND") {
                await tx.attendanceCaptureDevice.updateMany({
                  where: { tenantId: env.tenantId, acceptanceSiteRef: row.id },
                  data: { active: false },
                });
                Object.assign(changes, emptyApprovals, { state: "SUSPENDED" });
              } else if (input.action === "ACTIVATE") {
                if (
                  row.approvedHash !== row.contentHash ||
                  row.verifiedHash !== row.contentHash
                )
                  fail("Approval no longer matches this evidence version", 409);
                await tx.$executeRaw`SELECT set_config('app.attendance_acceptance',${row.id},true)`;
                for (const d of data.setup.inventory) {
                  await tx.attendanceCaptureDevice.updateMany({
                    where: { tenantId: env.tenantId, sn: d.sn },
                    data: {
                      active: d.mode !== "DISABLED",
                      acceptanceSiteRef: row.id,
                      acceptanceMode: d.mode,
                    },
                  });
                }
                Object.assign(changes, {
                  state: "ACTIVE",
                  activatedAt: new Date(),
                });
              } else if (input.action === "CLOSE_DEFECT") {
                const d = data.defects.find((d) => d.id === input.defectRef);
                if (!d || d.state === "CLOSED") fail("Open defect required");
                if (
                  [d.ownerCode, d.raisedByCode].includes(env.who.employee_code)
                )
                  fail(
                    "Independent HR verification is required to close a defect",
                    403,
                  );
                const r = data.runs[d.retestRunKey];
                if (
                  !d.resolution ||
                  d.retestRunKey !== d.runKey ||
                  !r ||
                  r.outcome !== "PASS" ||
                  (!d.evidenceRefs.length && !d.attachmentRefs.length) ||
                  r.recordedAt < d.updatedAt
                )
                  fail(
                    "Record a fresh passed retest, resolution and closure evidence",
                  );
                d.state = "CLOSED";
                d.closedByCode = env.who.employee_code;
                d.closedAt = new Date().toISOString();
              }
              row = await persist(
                tx,
                env,
                row,
                data,
                input.action,
                input.reason,
                changes,
              );
            }
          }
          result = output(env, { record: await view(tx, env, row) });
        }
      }
      if (input.requestKey)
        await tx.hrSetupReceipt.create({
          data: {
            tenantId: env.tenantId,
            requestKey: input.requestKey,
            actorUserId: env.who.userId,
            digest,
            result: seal(result),
          },
        });
      return result;
    },
    { tenantId: ctx.user.tenantId, txOptions: { timeout: 30000 } },
  );
}
