import { randomUUID } from "node:crypto";
import {
  nativeIdentity,
  nativeDigest,
  NATIVE_TENANT,
  BOOTSTRAP_ROLE_PREFIX,
} from "../../src/lib/native-verification-plan.js";

export function nativeFixture(now = new Date("2026-10-23T12:00:00.000Z"), suffix = "a1b2c3d4") {
  const runId = `sdlc-20261023-${suffix}`;
  const plan = {
    version: 1,
    grantId: randomUUID(),
    runId,
    companyId: 16,
    tenantId: NATIVE_TENANT,
    companyName: "Trusoft Live Website",
    approvedBy: { userId: 8, email: "irfan.abdi@trusoft.ai" },
    approvalRef: "test:explicit-native-run:20261023",
    operatorOrigin: {
      kind: "kubernetes-job",
      namespace: "trucodehub-ci",
      jobUid: randomUUID(),
      podUid: randomUUID(),
      sourceSha256: "a".repeat(64),
      controllerSha256: "b".repeat(64),
    },
    issuedAt: new Date(now.getTime() - 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 3500000).toISOString(),
    bootstrap: {
      userId: 901,
      roleId: 901,
      roleName: BOOTSTRAP_ROLE_PREFIX + runId.toUpperCase(),
      email: `${runId}-bootstrap@example.invalid`,
      userName: `${runId}_bootstrap`,
    },
    accounts: ["owner", "developer", "reviewer", "outsider"].map((persona, index) => ({
      ...nativeIdentity(runId, persona),
      roleId: 902 + index,
      entryId: randomUUID(),
    })),
  };
  const entry = plan.accounts[0];
  const data = {
    firstName: entry.firstName,
    lastName: entry.lastName,
    jobTitle: entry.jobTitle,
    gender: entry.gender,
    hireDate: entry.hireDate,
    mobilePhone: entry.phone,
    employeeCategory: entry.employeeCategory,
    createSystemAccount: true,
    systemEmail: entry.email,
    workEmail: entry.email,
    roleId: entry.roleId,
  };
  const ctx = {
    actorVerified: true,
    user: {
      userId: String(plan.bootstrap.userId),
      employeeId: null,
      email: plan.bootstrap.email,
      roles: [plan.bootstrap.roleName],
      tenantId: plan.tenantId,
      isAdmin: false,
    },
    permissions: ["hr.employee.create", "rbac.employee.create"],
  };
  const authorization = {
    plan,
    entry,
    fingerprint: nativeDigest(plan),
    requestFingerprint: nativeDigest(data),
  };
  return { plan, entry, data, ctx, authorization, now };
}
