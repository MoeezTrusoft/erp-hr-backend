// Public contract mirrored from the frozen RBAC native-verification v1 source.
// No credential material is loaded by HR. Changes require coordinated contract review.
import { createHash } from "node:crypto";

export const NATIVE_PERSONAS = Object.freeze(["owner", "developer", "reviewer", "outsider"]);
export const BOOTSTRAP_ROLE_PREFIX = "SDLC_VERIFY_BOOTSTRAP_";
export const NATIVE_TENANT = "066dd015-2820-47b5-b2fc-1e9704f0f420";
export const NATIVE_COMPANY = 16;
export const NATIVE_COMPANY_NAME = "Trusoft Live Website";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const nativeDigest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const nativeDenied = (code) => {
  throw Object.assign(new Error(code), { code, status: 403 });
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|")
  )
    nativeDenied("NATIVE_PLAN_SHAPE");
};
const date = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function nativeIdentity(runId, persona) {
  const digits = String(
    parseInt(createHash("sha256").update(`${runId}:${persona}`).digest("hex").slice(0, 12), 16) %
      1_000_000_000,
  ).padStart(9, "0");
  return {
    persona,
    email: `${runId}-${persona}@example.invalid`,
    userName: `${runId}_${persona}`,
    roleName: `${runId.toUpperCase()}_${persona.toUpperCase()}`,
    firstName: runId,
    lastName: persona,
    // +999 is an unassigned country prefix; these records cannot target a real subscriber.
    phone: `+999${digits}`,
    jobTitle: `SDLC verification ${persona}`,
    gender: "Other",
    employeeCategory: "EMPLOYEE",
    hireDate: `${runId.slice(5, 9)}-${runId.slice(9, 11)}-${runId.slice(11, 13)}T00:00:00.000Z`,
  };
}

export function validateNativePlan(value, { now = new Date(), allowExpired = false } = {}) {
  exact(value, [
    "version",
    "grantId",
    "runId",
    "companyId",
    "tenantId",
    "companyName",
    "approvedBy",
    "approvalRef",
    "operatorOrigin",
    "issuedAt",
    "expiresAt",
    "bootstrap",
    "accounts",
  ]);
  exact(value.approvedBy, ["userId", "email"]);
  exact(value.bootstrap, ["userId", "roleId", "roleName", "email", "userName"]);
  if (
    value.version !== 1 ||
    !uuid(value.grantId) ||
    !/^sdlc-\d{8}-[a-f0-9]{8}$/.test(value.runId) ||
    value.companyId !== NATIVE_COMPANY ||
    value.tenantId !== NATIVE_TENANT ||
    value.companyName !== NATIVE_COMPANY_NAME ||
    value.approvedBy.userId !== 8 ||
    value.approvedBy.email !== "irfan.abdi@trusoft.ai" ||
    !/^[A-Za-z0-9:._/-]{16,200}$/.test(value.approvalRef || "")
  )
    nativeDenied("NATIVE_PLAN_TARGET");
  validateNativeOperatorOrigin(value.operatorOrigin);
  if (
    !date(value.issuedAt) ||
    !date(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 3_600_000 ||
    Date.parse(value.issuedAt) > now.getTime() ||
    (!allowExpired && Date.parse(value.expiresAt) <= now.getTime())
  )
    nativeDenied("NATIVE_PLAN_EXPIRED");
  const bootstrap = value.bootstrap;
  if (
    !positive(bootstrap.userId) ||
    bootstrap.userId === 8 ||
    !positive(bootstrap.roleId) ||
    bootstrap.roleName !== BOOTSTRAP_ROLE_PREFIX + value.runId.toUpperCase() ||
    bootstrap.email !== `${value.runId}-bootstrap@example.invalid` ||
    bootstrap.userName !== `${value.runId}_bootstrap`
  )
    nativeDenied("NATIVE_BOOTSTRAP_IDENTITY");
  if (!Array.isArray(value.accounts) || value.accounts.length !== 4)
    nativeDenied("NATIVE_PERSONA_SET");
  const roleIds = new Set([bootstrap.roleId]);
  const entries = new Set();
  for (const persona of NATIVE_PERSONAS) {
    const records = value.accounts.filter((account) => account?.persona === persona);
    if (records.length !== 1) nativeDenied("NATIVE_PERSONA_SET");
    const account = records[0],
      expected = nativeIdentity(value.runId, persona);
    exact(account, [...Object.keys(expected), "roleId", "entryId"]);
    if (
      !uuid(account.entryId) ||
      entries.has(account.entryId) ||
      !positive(account.roleId) ||
      roleIds.has(account.roleId) ||
      !date(account.hireDate) ||
      Object.entries(expected).some(([key, expectedValue]) => account[key] !== expectedValue)
    )
      nativeDenied("NATIVE_ACCOUNT_PROFILE");
    roleIds.add(account.roleId);
    entries.add(account.entryId);
  }
  return value;
}

export function validateNativeOperatorOrigin(value) {
  exact(value, ["kind", "namespace", "jobUid", "podUid", "sourceSha256", "controllerSha256"]);
  if (
    value.kind !== "kubernetes-job" ||
    !["trucodehub-ci", "erp-svc"].includes(value.namespace) ||
    !uuid(value.jobUid) ||
    !uuid(value.podUid) ||
    !/^[a-f0-9]{64}$/.test(value.sourceSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(value.controllerSha256 || "")
  )
    nativeDenied("NATIVE_OPERATOR_ORIGIN");
  return value;
}

// The native HR worker derives this key from the committed employee identity.
export function nativeProvisioningKey(tenantId, employeeId) {
  const digest = nativeDigest(`hr:system-account:${tenantId}:${employeeId}:v1`);
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateNativeWorkerClaim(value) {
  exact(value, [
    "version",
    "grantId",
    "grantFingerprint",
    "runId",
    "entryId",
    "provisioningId",
    "employeeId",
    "idempotencyKey",
    "payloadFingerprint",
  ]);
  if (
    value.version !== 1 ||
    !uuid(value.grantId) ||
    !uuid(value.entryId) ||
    !uuid(value.provisioningId) ||
    !uuid(value.idempotencyKey) ||
    !positive(value.employeeId) ||
    !/^sdlc-\d{8}-[a-f0-9]{8}$/.test(value.runId) ||
    !/^[a-f0-9]{64}$/.test(value.grantFingerprint || "") ||
    !/^[a-f0-9]{64}$/.test(value.payloadFingerprint || "")
  )
    nativeDenied("NATIVE_WORKER_CLAIM");
  return value;
}

export function assertNativePayload(
  plan,
  data,
  { actorId, tenantId, source, service, verifiedNativeGrant, key, fingerprint, claim },
) {
  if (
    actorId !== plan.bootstrap.userId ||
    tenantId !== plan.tenantId ||
    source !== "service-jwt" ||
    service !== "erp-hr-backend" ||
    verifiedNativeGrant !== true
  )
    nativeDenied("NATIVE_WORKER_IDENTITY");
  validateNativeWorkerClaim(claim);
  if (
    claim.grantId !== plan.grantId ||
    claim.grantFingerprint !== nativeDigest(plan) ||
    claim.runId !== plan.runId
  )
    nativeDenied("NATIVE_GRANT_BINDING");
  const account = plan.accounts.find((record) => record.entryId === claim.entryId);
  if (!account || !positive(data.hrEmployeeId)) nativeDenied("NATIVE_HR_EMPLOYEE_REQUIRED");
  const expected = {
    first_name: account.firstName,
    last_name: account.lastName,
    job_title: account.jobTitle,
    email: account.email,
    phone: account.phone,
    gender: account.gender,
    hire_date: account.hireDate,
    status: "Active",
  };
  if (
    Object.entries(expected).some(([name, value]) => data[name] !== value) ||
    !Array.isArray(data.roles) ||
    data.roles.length !== 1 ||
    String(data.roles[0].roleId) !== String(account.roleId) ||
    Object.keys(data.roles[0]).some((name) => name !== "roleId") ||
    data.mediaId != null ||
    data.departmentId != null ||
    Object.keys(data).some(
      (name) =>
        ![
          ...Object.keys(expected),
          "roles",
          "hrEmployeeId",
          "mediaId",
          "departmentId",
          "password",
        ].includes(name),
    )
  )
    nativeDenied("NATIVE_PROFILE_SCOPE");
  const business = { ...data };
  delete business.password;
  if (
    key !== nativeProvisioningKey(plan.tenantId, data.hrEmployeeId) ||
    fingerprint !== nativeDigest(business)
  )
    nativeDenied("NATIVE_INTENT_BINDING");
  if (
    claim.employeeId !== data.hrEmployeeId ||
    claim.idempotencyKey !== key ||
    claim.payloadFingerprint !== fingerprint
  )
    nativeDenied("NATIVE_RECEIPT_BINDING");
  return account;
}
