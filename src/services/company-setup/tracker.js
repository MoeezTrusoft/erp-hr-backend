import { createHash } from "node:crypto";
import { decryptString, encryptString } from "../../lib/crypto.js";
import {
  SetupTaskSave,
  SetupEvidenceUpload,
  SetupEvidenceRead,
} from "@trusoft/contracts/hr-company-setup";
import {
  command,
  transact,
  result,
  fail,
  hash,
  seal,
  unseal,
  audit,
  version,
} from "./base.js";
import {
  active,
  employees,
  employeePublic,
  identityIssues,
} from "./sources.js";
import { companySetupSnapshot } from "../rbac.client.js";

// These are decisions/evidence HR must complete, not automatic approvals.
const companyTasks = [
  [
    "independent-authority",
    "Independent approval coverage",
    "P0",
    "Verify company HR and Management permissions and an independent alternate for an approver's own employee setup. Record approved delegation and role-grant evidence.",
  ],
  [
    "identity",
    "Identity clarification",
    "P0",
    "Resolve each company/account case using ownership evidence. Link only an unoccupied employee code in this company or remove company access after approval. Preserve other legitimate memberships.",
  ],
  [
    "category",
    "Employment categories",
    "P1",
    "Verify categories from appointment records. Use category conversion for existing classifications; neither a title nor an employee-code prefix establishes category.",
  ],
  [
    "grades",
    "Grade catalogue and assignment",
    "P1",
    "Approve company grade definitions and employee placements. Cover each active category/grade pair in the authority matrix.",
  ],
  [
    "notice",
    "Contract and policy notice rules",
    "P1",
    "Record evidenced contract notice or an approved category/grade fallback. Blank is not zero. Record historical cleanup decisions for inactive employees.",
  ],
  [
    "managers",
    "Company reporting-line sheet",
    "P1",
    "Verify employee code, manager code, effective date and evidence. Reject cycles and managers outside this company. A top-level Management exception requires classification and policy authority.",
  ],
  [
    "accounts",
    "Employee and manager accounts",
    "P0",
    "Verify required company memberships, primary links and roles. Test manager request routing. Review enabled accounts for inactive employees before scoped access removal.",
  ],
  [
    "policy-evidence",
    "Policy evidence and jurisdiction",
    "P1",
    "Provide controlled jurisdiction, employer-initiated separation, retention/access and integration-evidence references. Obtain company-specific policy review.",
  ],
  [
    "separation-types",
    "Eight separation workflows",
    "P1",
    "Review resignation, termination with cause, termination without cause, contract end, internship completion, retirement, mutual separation and death in service: initiators, documents, notice treatment and withdrawal.",
  ],
  [
    "owners",
    "Authority and clearance owners",
    "P1",
    "Confirm category/grade approval authority, HR codes, IT and payroll owners, and clearance department owners/signers with active authorized accounts.",
  ],
  [
    "templates",
    "Controlled letter templates",
    "P1",
    "Approve acceptance, termination, clearance and experience templates, references and rendered sample letters.",
  ],
  [
    "settlement",
    "Settlement and operational settings",
    "P1",
    "Verify currency/precision, leave encashment, notice recovery/pay, time zone and reminders. Attach payroll, access removal, assets and clearance test evidence.",
  ],
  [
    "corrections",
    "Employee and identity correction reviews",
    "P1",
    "Finish required employee/identity decisions and approved activations before submitting the completed policy package. Link relevant ERP reviews and verify the resulting live records.",
  ],
];
const finished = (s) => ["COMPLETE", "NOT_APPLICABLE"].includes(s);
const blank = (v) => !String(v || "").trim();
export function taskDefinitions(rows, grades, remote) {
  const defs = companyTasks.map(([key, title, priority, guidance]) => ({
    taskKey: "company:" + key,
    category: "POLICY",
    title,
    priority,
    guidance,
    subject: null,
    allowNA: false,
    observed: "Company-specific evidence and verification required",
    sourceHash: hash({ key, guidance }),
  }));
  for (const e of rows) {
    const p = employeePublic(e, rows, grades),
      issues = [];
    if (!p.category) issues.push("Employment category missing");
    if (!p.gradeCode) issues.push("Grade missing");
    if (p.contractNoticeDays == null)
      issues.push("Contract notice or policy fallback required");
    if (!p.managerCode)
      issues.push(
        "Manager or documented Management authority exception required",
      );
    if (blank(p.status) || blank(p.employmentStatus))
      issues.push(
        "Blank employment-status field: approved employee-maintenance correction required",
      );
    else if (
      active({ status: p.status }) !== active({ status: p.employmentStatus })
    )
      issues.push("Conflicting employment-status fields");
    const account = remote?.accounts.find(
      (a) => a.userId === e.userId && a.member && a.enabled,
    );
    if (p.active && remote && !account)
      issues.push("Active employee requires a verified enabled company login");
    if (!p.active && account)
      issues.push("Inactive/disabled employee retains enabled company access");
    const reports = rows.filter(
      (r) => r.managerId === e.id && active(r),
    ).length;
    if (reports && remote && !account)
      issues.push(
        `Manager account needed for ${reports} active direct reports`,
      );
    defs.push({
      taskKey: "employee:" + hash(p.employeeCode).slice(0, 32),
      category: "EMPLOYEE_SETUP",
      subject: p.employeeCode,
      title: p.employeeCode,
      priority: issues.some((x) => /status|account|login|access/i.test(x))
        ? "P0"
        : "P1",
      observed:
        issues.join("; ") ||
        "Verify current setup against controlled employee records",
      guidance: p.active
        ? "Verify each finding, attach employment evidence and link approved corrections. Complete company reporting-line and notice decisions; do not invent missing values."
        : "Review historical gaps and any retained account access. N/A requires a documented inactive-record scope decision; it cannot waive live access or identity blockers.",
      allowNA: !p.active && !account,
      sourceHash: hash({
        p,
        issues,
        account: account
          ? {
              enabled: account.enabled,
              member: account.member,
              code: account.employeeCode,
            }
          : null,
      }),
    });
  }
  for (const c of remote ? identityIssues(rows, remote) : [])
    defs.push({
      taskKey: "identity:" + hash(c.login).slice(0, 32),
      category: "IDENTITY",
      subject: c.login,
      title: c.login,
      priority: "P0",
      observed: c.issues.join("; "),
      allowNA: false,
      guidance:
        "Confirm company and account ownership from evidence. Do not overwrite an occupied primary link or link an employee from another company. Apply approved corrections through the identity review and recheck the result.",
      sourceHash: hash(c),
    });
  return defs;
}
async function frozenReview(tx, env) {
  return tx.hrSetupReview.findFirst({
    where: {
      tenantId: env.tenantId,
      kind: "POLICY",
      state: { in: ["MANAGEMENT", "APPROVED"] },
    },
    select: { id: true, state: true },
  });
}
async function writable(tx, env) {
  if (await frozenReview(tx, env))
    fail(
      "The company action list is frozen for Management review. Management must return the policy to HR before changes.",
      409,
    );
}
export async function buildTracker(tx, env, { remote, history = false } = {}) {
  let available = true;
  if (!remote)
    try {
      remote = await companySetupSnapshot();
    } catch {
      available = false;
    }
  const rows = await employees(tx, env),
    grades = await tx.gradeLevel.findMany({
      where: { tenantId: env.tenantId },
    }),
    stored = await tx.hrSetupTask.findMany({
      where: { tenantId: env.tenantId },
      orderBy: { taskKey: "asc" },
    }),
    files = await tx.hrSetupEvidence.findMany({
      where: { tenantId: env.tenantId },
      select: {
        id: true,
        taskKey: true,
        payload: true,
        uploadedByCode: true,
        createdAt: true,
      },
    }),
    defs = taskDefinitions(rows, grades, remote),
    events = history
      ? await tx.hrSetupAudit.findMany({
          where: {
            tenantId: env.tenantId,
            reviewRef: { in: stored.map((r) => r.id) },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
  // Retain resolved cases and retired employees so their evidence is never silently lost.
  for (const r of stored)
    if (!defs.some((d) => d.taskKey === r.taskKey)) {
      const d = unseal(r.payload).definition;
      defs.push({
        ...d,
        observed:
          "No current finding; verify the resolution and retain the evidence",
        allowNA: d.category === "EMPLOYEE_SETUP",
        sourceHash: hash({ taskKey: r.taskKey, resolved: true }),
      });
    }
  const items = defs
    .map((d) => {
      const saved = stored.find((r) => r.taskKey === d.taskKey),
        p = saved ? unseal(saved.payload) : {},
        stale = finished(p.status) && p.definition.sourceHash !== d.sourceHash,
        attachments = files
          .filter((f) => f.taskKey === d.taskKey)
          .map((f) => {
            const meta = unseal(f.payload);
            return {
              evidenceRef: f.id,
              ...meta,
              uploadedByCode: f.uploadedByCode,
              createdAt: f.createdAt.toISOString(),
            };
          });
      return {
        ...d,
        version: saved?.version || 0,
        ownerCode: p.ownerCode || null,
        dueDate: p.dueDate || null,
        status: p.status || "NOT_STARTED",
        notes: p.notes || "",
        evidenceRefs: p.evidenceRefs || [],
        attachmentRefs: p.attachmentRefs || [],
        reviewRefs: p.reviewRefs || [],
        stale: !!stale,
        ownerValid:
          !!p.ownerCode &&
          rows.some((e) => e.employee_code === p.ownerCode && active(e)),
        overdue:
          !!p.dueDate &&
          p.dueDate < new Date().toISOString().slice(0, 10) &&
          (!finished(p.status) || stale),
        attachments,
        updatedAt: saved?.updatedAt.toISOString() || null,
        ...(history
          ? {
              history: events
                .filter((e) => e.reviewRef === saved?.id)
                .map((e) => ({
                  version: e.version,
                  action: e.action,
                  actorCode: e.actorCode,
                  reason: decryptString(e.reason),
                  at: e.createdAt.toISOString(),
                })),
            }
          : {}),
      };
    })
    .sort((a, b) => a.taskKey.localeCompare(b.taskKey));
  const blockers = items.flatMap((i) => {
    if (!finished(i.status))
      return [`${i.title}: ${i.status.toLowerCase().replaceAll("_", " ")}`];
    if (i.stale) return [`${i.title}: source changed; verify completion again`];
    if (!i.ownerValid) return [`${i.title}: active company owner required`];
    if (i.status === "NOT_APPLICABLE" && !i.allowNA)
      return [`${i.title}: N/A is not allowed for this current finding`];
    return [];
  });
  if (!available)
    blockers.unshift(
      "Account service unavailable; company completion cannot be verified",
    );
  const frozen = await frozenReview(tx, env);
  return {
    items,
    blockers,
    identityAvailable: available,
    frozenReviewRef: frozen?.id || null,
    counts: {
      total: items.length,
      completed: items.filter(
        (i) => finished(i.status) && !i.stale && i.ownerValid,
      ).length,
      blocked: items.filter((i) => i.status === "BLOCKED").length,
      overdue: items.filter((i) => i.overdue).length,
    },
    editorUserIds: [...new Set(stored.flatMap((r) => r.editorUserIds))],
  };
}
export function completionSnapshot(tracker) {
  const items = tracker.items.map(
    ({ attachments, history: _history, overdue: _overdue, ...i }) => ({
      ...i,
      attachments: attachments.filter((f) =>
        i.attachmentRefs.includes(f.evidenceRef),
      ),
    }),
  );
  return {
    formatVersion: 1,
    digest: hash(items),
    items,
    blockers: tracker.blockers,
  };
}
export async function verifyCompletion(tx, env, saved, remote) {
  const tracker = await buildTracker(tx, env, { remote });
  if (tracker.blockers.length)
    fail("Company actions incomplete: " + tracker.blockers.join("; "), 409);
  const current = completionSnapshot(tracker);
  if (!saved || saved.digest !== current.digest)
    fail(
      "Company action evidence changed. Return to HR if needed and refresh the policy action snapshot before submission, approval or activation.",
      409,
    );
  return tracker;
}
export async function readTasks() {
  return transact(null, async (tx, env) => {
    const { editorUserIds: _editors, ...tracker } = await buildTracker(
      tx,
      env,
      { history: true },
    );
    return result(env, { tracker });
  });
}
async function taskContext(tx, env, input) {
  await writable(tx, env);
  const tracker = await buildTracker(tx, env),
    task = tracker.items.find((t) => t.taskKey === input.taskKey);
  if (!task) fail("Action not found in this company", 404);
  version(task, input);
  const old = await tx.hrSetupTask.findUnique({
    where: {
      tenantId_taskKey: { tenantId: env.tenantId, taskKey: input.taskKey },
    },
  });
  return { task, old };
}
async function persistTask(tx, env, task, old, data, reason) {
  const definition = Object.fromEntries(
    [
      "taskKey",
      "category",
      "subject",
      "title",
      "priority",
      "observed",
      "guidance",
      "allowNA",
      "sourceHash",
    ].map((k) => [k, task[k]]),
  );
  const payload = { ...data, definition },
    values = {
      payload: seal(payload),
      editorUserIds: [
        ...new Set([...(old?.editorUserIds || []), env.who.userId]),
      ],
    };
  const row = old
    ? await tx.hrSetupTask.update({
        where: { id: old.id },
        data: { ...values, version: { increment: 1 } },
      })
    : await tx.hrSetupTask.create({
        data: { ...values, tenantId: env.tenantId, taskKey: task.taskKey },
      });
  await audit(
    tx,
    env,
    { ...row, contentHash: hash(payload) },
    "TASK_UPDATE",
    reason,
  );
  return result(env, {
    tracker: { savedTaskKey: task.taskKey, version: row.version },
  });
}
export async function saveTask(raw) {
  const input = SetupTaskSave.parse(raw);
  return command(input, "prepare", "TASK_SAVE", async (tx, env) => {
    const { task, old } = await taskContext(tx, env, input),
      rows = await employees(tx, env);
    if (
      input.ownerCode &&
      !rows.some((e) => e.employee_code === input.ownerCode && active(e))
    )
      fail("Choose an active owner employee code in this company");
    if (input.status === "NOT_APPLICABLE" && !task.allowNA)
      fail(
        "N/A is only allowed for inactive historical setup without enabled company access",
      );
    for (const ref of input.attachmentRefs)
      if (!task.attachments.some((f) => f.evidenceRef === ref))
        fail("Evidence attachment does not belong to this company action", 403);
    const reviews = await tx.hrSetupReview.findMany({
      where: { tenantId: env.tenantId, id: { in: input.reviewRefs } },
    });
    if (
      reviews.length !== new Set(input.reviewRefs).size ||
      reviews.some((r) => r.kind === "POLICY")
    )
      fail("Link employee or identity reviews from this company only");
    if (finished(input.status)) {
      if (
        !input.ownerCode ||
        !input.dueDate ||
        !input.notes ||
        !(input.evidenceRefs.length + input.attachmentRefs.length)
      )
        fail("Completion requires an owner, due date, findings and evidence");
      if (reviews.some((r) => r.state !== "ACTIVE"))
        fail(
          "Linked correction reviews must be activated before marking this action complete",
        );
    }
    const {
      requestKey: _key,
      expectedVersion: _v,
      taskKey: _task,
      reason,
      ...data
    } = input;
    return persistTask(tx, env, task, old, data, reason);
  });
}
export function fileData(input) {
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (
    !bytes.length ||
    bytes.length > 2 * 1024 * 1024 ||
    bytes.toString("base64") !== input.contentBase64
  )
    fail("Upload a valid file of at most 2 MiB");
  const ext = input.fileName.split(".").pop().toLowerCase();
  const types = {
    pdf: ["application/pdf", bytes.subarray(0, 5).toString() === "%PDF-"],
    png: [
      "image/png",
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ],
    jpg: [
      "image/jpeg",
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    ],
    jpeg: [
      "image/jpeg",
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    ],
    docx: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])),
    ],
    xlsx: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])),
    ],
  };
  if (!types[ext]?.[1])
    fail(
      "Supported evidence: PDF, PNG, JPEG, DOCX or XLSX with matching file content",
    );
  return {
    fileName: input.fileName,
    mimeType: types[ext][0],
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: input.contentBase64,
  };
}
export async function uploadEvidence(raw) {
  const input = SetupEvidenceUpload.parse(raw),
    file = fileData(input);
  return command(input, "prepare", "EVIDENCE_UPLOAD", async (tx, env) => {
    const { task, old } = await taskContext(tx, env, input);
    if (task.attachments.length >= 20)
      fail(
        "Each action supports at most 20 evidence files; use controlled references for additional evidence",
      );
    const { contentBase64, ...metadata } = file;
    const f = await tx.hrSetupEvidence.create({
      data: {
        tenantId: env.tenantId,
        taskKey: task.taskKey,
        payload: seal(metadata),
        content: encryptString(contentBase64),
        uploadedByCode: env.who.employee_code,
      },
    });
    const previous = old
      ? unseal(old.payload)
      : {
          ownerCode: null,
          dueDate: null,
          status: "NOT_STARTED",
          notes: "",
          evidenceRefs: [],
          attachmentRefs: [],
          reviewRefs: [],
        };
    const output = await persistTask(
      tx,
      env,
      task,
      old,
      {
        ...previous,
        status: finished(previous.status) ? "IN_PROGRESS" : previous.status,
        attachmentRefs: [...previous.attachmentRefs, f.id],
      },
      input.reason,
    );
    return result(env, {
      tracker: output.tracker,
      evidence: {
        evidenceRef: f.id,
        fileName: file.fileName,
        sha256: file.sha256,
        size: file.size,
      },
    });
  });
}
export async function readEvidence(raw) {
  const input = SetupEvidenceRead.parse(raw);
  return transact(null, async (tx, env) => {
    const file = await tx.hrSetupEvidence.findFirst({
      where: { id: input.evidenceRef, tenantId: env.tenantId },
    });
    if (!file) fail("Evidence not found in this company", 404);
    return result(env, {
      evidence: {
        evidenceRef: file.id,
        ...unseal(file.payload),
        contentBase64: decryptString(file.content),
      },
    });
  });
}
