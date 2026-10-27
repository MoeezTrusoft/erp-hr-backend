// Invoked only by the shared maintenance controller. No HTTP/MCP registration.
// The controller must verify the actual Job/Pod ledger and mount this dispatch
// read-only. Field shape/UID strings alone are not operator authorization.
import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, stat, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  nativeDigest,
  nativeProvisioningKey,
  validateNativeWorkerClaim,
  validateNativePlan,
  validateNativeOperatorOrigin,
} from "../src/lib/native-verification-plan.js";
import {
  HR_NATIVE_PLAN_PATH,
  nativeHrDenied,
} from "../src/services/native-verification-guard.service.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ref = (value) => typeof value === "string" && /^[A-Za-z0-9:._/-]{16,200}$/.test(value);
const logId = (value) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number(value) <= 2147483647;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

export function nativeRbacReceiptFingerprint(plan, type, id, authorizationId) {
  return nativeDigest({
    version: 1,
    type,
    id,
    tenantId: plan.tenantId,
    userId: plan.bootstrap.userId,
    grantId: plan.grantId,
    planFingerprint: nativeDigest(plan),
    ...(type === "BOOTSTRAP_CANCELLED" ? { authorizationId } : {}),
  });
}

export function validateHrNativeDispatch(dispatch, planBytes, env, now = new Date()) {
  if (
    !exact(dispatch, [
      "version",
      "operation",
      "planSha256",
      "planFingerprint",
      "grantId",
      "runId",
      "tenantId",
      "operatorOrigin",
      "dispatch",
      "rbacAuthorization",
      "rbacCancellation",
      "operationRef",
    ]) ||
    dispatch.version !== 1 ||
    !["INSTALL", "CANCEL"].includes(dispatch.operation) ||
    !ref(dispatch.operationRef)
  )
    nativeHrDenied();
  const plan = validateNativePlan(JSON.parse(planBytes), {
    now,
    allowExpired: dispatch.operation === "CANCEL",
  });
  if (
    dispatch.planSha256 !== sha(planBytes) ||
    dispatch.planFingerprint !== nativeDigest(plan) ||
    dispatch.grantId !== plan.grantId ||
    dispatch.runId !== plan.runId ||
    dispatch.tenantId !== plan.tenantId ||
    nativeDigest(dispatch.operatorOrigin) !== nativeDigest(plan.operatorOrigin)
  )
    nativeHrDenied();
  if (
    !exact(dispatch.dispatch, [
      "kind",
      "namespace",
      "jobName",
      "jobUid",
      "podUid",
      "sourceSha256",
      "controllerSha256",
    ])
  )
    nativeHrDenied();
  const { jobName, ...origin } = dispatch.dispatch;
  validateNativeOperatorOrigin(origin);
  if (
    !/^sdlc-native-[a-z0-9-]{1,43}$/.test(jobName) ||
    origin.namespace !== env.SDLC_OPERATOR_NAMESPACE ||
    jobName !== env.SDLC_OPERATOR_JOB_NAME ||
    origin.jobUid !== env.SDLC_OPERATOR_JOB_UID ||
    origin.podUid !== env.SDLC_OPERATOR_POD_UID
  )
    nativeHrDenied();
  if (
    !exact(dispatch.rbacAuthorization, ["id", "fingerprint"]) ||
    !logId(dispatch.rbacAuthorization.id) ||
    !hash(dispatch.rbacAuthorization.fingerprint) ||
    dispatch.rbacAuthorization.fingerprint !==
      nativeRbacReceiptFingerprint(plan, "BOOTSTRAP_AUTHORIZATION", dispatch.rbacAuthorization.id)
  )
    nativeHrDenied();
  if (dispatch.operation === "INSTALL" && dispatch.rbacCancellation !== null) nativeHrDenied();
  if (
    dispatch.operation === "CANCEL" &&
    (!exact(dispatch.rbacCancellation, ["id", "fingerprint", "grantId"]) ||
      !logId(dispatch.rbacCancellation.id) ||
      !hash(dispatch.rbacCancellation.fingerprint) ||
      dispatch.rbacCancellation.grantId !== plan.grantId ||
      dispatch.rbacCancellation.fingerprint !==
        nativeRbacReceiptFingerprint(
          plan,
          "BOOTSTRAP_CANCELLED",
          dispatch.rbacCancellation.id,
          dispatch.rbacAuthorization.id,
        ))
  )
    nativeHrDenied();
  return { plan, dispatch };
}

export async function applyHrNativeGrant(
  { prisma, transaction, updateEmployeeStatus },
  { plan, dispatch },
  now = new Date(),
) {
  return transaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${plan.tenantId}:native:${plan.grantId}`},0))`;
      await tx.$queryRaw`SELECT id FROM "NativeVerificationGrant" WHERE id=${plan.grantId}::uuid AND "tenantId"=${plan.tenantId}::uuid FOR UPDATE`;
      let grant = await tx.nativeVerificationGrant.findFirst({
        where: { tenantId: plan.tenantId, id: plan.grantId },
      });
      if (
        grant &&
        (grant.fingerprint !== dispatch.planFingerprint ||
          nativeDigest(grant.plan) !== dispatch.planFingerprint ||
          grant.operatorReceiptId !== dispatch.rbacAuthorization.id ||
          grant.operatorReceiptFingerprint !== dispatch.rbacAuthorization.fingerprint)
      )
        nativeHrDenied();
      if (dispatch.operation === "INSTALL") {
        validateNativePlan(plan, { now });
        if (grant?.cancelledAt) nativeHrDenied();
        if (!grant)
          grant = await tx.nativeVerificationGrant.create({
            data: {
              id: plan.grantId,
              tenantId: plan.tenantId,
              runId: plan.runId,
              plan,
              fingerprint: dispatch.planFingerprint,
              bootstrapUserId: plan.bootstrap.userId,
              operatorReceiptId: dispatch.rbacAuthorization.id,
              operatorReceiptFingerprint: dispatch.rbacAuthorization.fingerprint,
              issuedAt: new Date(plan.issuedAt),
              expiresAt: new Date(plan.expiresAt),
            },
          });
      } else {
        if (!grant) nativeHrDenied();
        if (!grant.cancelledAt)
          await tx.nativeVerificationGrant.update({
            where: { id: grant.id },
            data: { cancelledAt: now, cancellationRef: dispatch.operationRef },
          });
      }
      const entries = await tx.nativeVerificationEntry.findMany({
        where: { tenantId: plan.tenantId, grantId: plan.grantId },
        orderBy: { entryId: "asc" },
      });
      if (dispatch.operation === "CANCEL") {
        await tx.systemAccountProvisioning.updateMany({
          where: {
            tenantId: plan.tenantId,
            id: { in: entries.map((entry) => entry.provisioningId) },
            status: { not: "SUCCEEDED" },
          },
          data: {
            status: "TERMINAL_FAILED",
            nextAttemptAt: null,
            claimedAt: null,
            claimedBy: null,
            claimExpiresAt: null,
            lastErrorCode: "HR-0310",
            lastError: "Native verification authorization cancelled",
          },
        });
        for (const entry of entries) {
          await tx.$queryRaw`SELECT id FROM "Employee" WHERE id=${entry.employeeId} AND tenant_id=${plan.tenantId}::uuid FOR UPDATE`;
          const employee = await tx.employee.findFirst({
            where: { id: entry.employeeId, tenant_id: plan.tenantId },
          });
          if (!employee) nativeHrDenied();
          if (entry.deactivatedAt) {
            if (
              !entry.deactivationReceiptId ||
              employee.status !== "Inactive" ||
              employee.employement_status !== "Inactive"
            )
              nativeHrDenied();
          } else {
            if (!updateEmployeeStatus) nativeHrDenied();
            await updateEmployeeStatus(entry.employeeId, "Inactive", null, { client: tx });
            entry.deactivatedAt = now;
            entry.deactivationReceiptId = randomUUID();
            await tx.nativeVerificationEntry.update({
              where: { entryId: entry.entryId },
              data: {
                deactivatedAt: entry.deactivatedAt,
                deactivationReceiptId: entry.deactivationReceiptId,
              },
            });
          }
        }
      }
      await tx.log.create({
        data: {
          tenantId: plan.tenantId,
          type: dispatch.operation,
          action_type: `NATIVE_GRANT_${dispatch.operation}`,
          module: "SDLCNativeVerification",
          result: "SUCCESS",
          ip: "operator",
          os: "kubernetes",
          notes: JSON.stringify({
            grantId: plan.grantId,
            runId: plan.runId,
            operator: dispatch.dispatch,
            operationRef: dispatch.operationRef,
            requestingRbacUserId: plan.approvedBy.userId,
            rbacAuthorization: dispatch.rbacAuthorization,
            rbacCancellation: dispatch.rbacCancellation,
          }),
        },
      });
      return {
        state: dispatch.operation === "INSTALL" ? "INSTALLED" : "CANCELLED",
        grantId: plan.grantId,
        entries: entries.map((entry) => ({
          employeeId: entry.employeeId,
          provisioningId: entry.provisioningId,
          entryId: entry.entryId,
          idempotencyKey: entry.idempotencyKey,
          payloadFingerprint: entry.payloadFingerprint,
          deactivationReceiptId: entry.deactivationReceiptId ?? null,
        })),
      };
    },
    { tenantId: plan.tenantId, txOptions: { timeout: 30000 } },
  );
}

async function readOwnedInput(path) {
  const info = await stat(path);
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || info.size > 32768) nativeHrDenied();
  return readFile(path);
}

async function writePrivateArtifact(value, name, directory) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  const temporary = `${directory}/.hr-native-cleanup-${randomUUID()}.tmp`;
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } finally {
    await output.close();
  }
  try {
    // Atomic, no replacement of an existing receipt, and the final inode is 0600.
    await link(temporary, `${directory}/${name}`);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary);
  }
  return sha(bytes);
}

export function writeCleanupArtifact(value, directory = "/artifacts") {
  return writePrivateArtifact(value, "hr-native-cleanup.json", directory);
}

export async function publishNativeResult({
  authorized,
  result,
  receipts = null,
  directory = "/artifacts",
}) {
  const { plan, dispatch } = authorized;
  const cancelled = dispatch.operation === "CANCEL";
  if (
    !ref(dispatch.operationRef) ||
    dispatch.grantId !== plan.grantId ||
    dispatch.planFingerprint !== nativeDigest(plan) ||
    !logId(dispatch.rbacAuthorization?.id) ||
    dispatch.rbacAuthorization.fingerprint !==
      nativeRbacReceiptFingerprint(
        plan,
        "BOOTSTRAP_AUTHORIZATION",
        dispatch.rbacAuthorization.id,
      ) ||
    (cancelled
      ? !logId(dispatch.rbacCancellation?.id) ||
        dispatch.rbacCancellation.grantId !== plan.grantId ||
        dispatch.rbacCancellation.fingerprint !==
          nativeRbacReceiptFingerprint(
            plan,
            "BOOTSTRAP_CANCELLED",
            dispatch.rbacCancellation.id,
            dispatch.rbacAuthorization.id,
          )
      : dispatch.rbacCancellation !== null)
  )
    nativeHrDenied();
  if (
    !["INSTALL", "CANCEL"].includes(dispatch.operation) ||
    result.state !== (cancelled ? "CANCELLED" : "INSTALLED") ||
    result.grantId !== plan.grantId ||
    !Array.isArray(result.entries) ||
    result.entries.length > 4
  )
    nativeHrDenied();
  const entryKeys = [
    "entryId",
    "employeeId",
    "provisioningId",
    "idempotencyKey",
    "payloadFingerprint",
    "deactivationReceiptId",
  ];
  for (const entry of result.entries) {
    if (
      !exact(entry, entryKeys) ||
      !plan.accounts.some((account) => account.entryId === entry.entryId) ||
      entry.idempotencyKey !== nativeProvisioningKey(plan.tenantId, entry.employeeId)
    )
      nativeHrDenied();
    validateNativeWorkerClaim({
      version: 1,
      grantId: plan.grantId,
      grantFingerprint: nativeDigest(plan),
      runId: plan.runId,
      entryId: entry.entryId,
      provisioningId: entry.provisioningId,
      employeeId: entry.employeeId,
      idempotencyKey: entry.idempotencyKey,
      payloadFingerprint: entry.payloadFingerprint,
    });
    if (
      cancelled
        ? !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            entry.deactivationReceiptId || "",
          )
        : entry.deactivationReceiptId !== null
    )
      nativeHrDenied();
  }
  for (const key of ["entryId", "employeeId", "provisioningId", "idempotencyKey"])
    if (new Set(result.entries.map((entry) => entry[key])).size !== result.entries.length)
      nativeHrDenied();
  let artifactSha256 = null;
  if (cancelled) {
    if (
      !Array.isArray(receipts) ||
      result.entries.length !== receipts.length ||
      receipts.some(
        (receipt) =>
          !exact(receipt, ["entryId", "token"]) ||
          typeof receipt.token !== "string" ||
          !receipt.token,
      ) ||
      new Set(receipts.map((receipt) => receipt.entryId)).size !== receipts.length ||
      result.entries.some((entry) => !receipts.some((receipt) => receipt.entryId === entry.entryId))
    )
      nativeHrDenied();
    artifactSha256 = await writeCleanupArtifact({ grantId: result.grantId, receipts }, directory);
  } else if (receipts !== null) nativeHrDenied();
  const summary = {
    version: 1,
    operation: dispatch.operation,
    operationRef: dispatch.operationRef,
    state: result.state,
    grantId: result.grantId,
    planFingerprint: nativeDigest(plan),
    rbacAuthorization: dispatch.rbacAuthorization,
    rbacCancellation: dispatch.rbacCancellation,
    ownedEmployeeCount: result.entries.length,
    entries: result.entries,
    artifactSha256,
  };
  await writePrivateArtifact(summary, "result.json", directory);
  return summary;
}

async function main() {
  if (process.platform !== "linux" || !process.env.KUBERNETES_SERVICE_HOST) nativeHrDenied();
  const [control, planBytes] = await Promise.all([
    readOwnedInput("/control/hr-native-grant.json"),
    readOwnedInput(HR_NATIVE_PLAN_PATH),
  ]);
  const authorized = validateHrNativeDispatch(JSON.parse(control), planBytes, process.env);
  const { default: prisma } = await import("../src/lib/prisma.js");
  const { default: logger } = await import("../src/lib/logger.js");
  const { mcpCtx } = await import("../src/mcp/context.js");
  const { tenantTransaction } = await import("../src/lib/rlsTenant.js");
  try {
    const { updateEmployeeStatus } = await import("../src/services/hrContract.service.js");
    const result = await mcpCtx.run({ system: true }, () =>
      applyHrNativeGrant(
        { prisma, transaction: tenantTransaction, updateEmployeeStatus },
        authorized,
      ),
    );
    if (authorized.dispatch.operation === "CANCEL") {
      const { signNativeCleanupJwt } = await import("../src/lib/serviceJwt.js");
      const receipts = result.entries.map((entry) => {
        const sdlcCleanup = {
          version: 1,
          grantId: authorized.plan.grantId,
          grantFingerprint: nativeDigest(authorized.plan),
          runId: authorized.plan.runId,
          tenantId: authorized.plan.tenantId,
          bootstrapUserId: authorized.plan.bootstrap.userId,
          ...entry,
          employeeStatus: "Inactive",
          grantStatus: "CANCELLED",
        };
        const token = signNativeCleanupJwt(sdlcCleanup);
        if (!token) nativeHrDenied();
        return { entryId: entry.entryId, token };
      });
      // Signing occurs only after the transaction above commits. A failed/lost
      // output is reissued from the same durable receipt on the next owned job.
      await publishNativeResult({ authorized, result, receipts });
    } else {
      await publishNativeResult({ authorized, result });
    }
    logger.info(
      { state: result.state, grantId: result.grantId, ownedEmployeeCount: result.entries.length },
      "Native HR operator receipt applied",
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stderr.write(
      "HR-0310: native operator action failed; inspect durable receipts before retry\n",
    );
    process.exitCode = 1;
  }
}
