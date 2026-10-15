import { hash, fail, json, unseal } from "./base.js";
import { companySetupSnapshot } from "../rbac.client.js";
export const active = (e) =>
  !/inactive|disabled|terminated|exited|offboard|separated/i.test(
    `${e.status} ${e.employement_status}`,
  );
const fields = {
  id: true,
  employee_code: true,
  employeeCategory: true,
  gradeLevelId: true,
  contractNoticeDays: true,
  managerId: true,
  userId: true,
  status: true,
  employement_status: true,
};
export async function employees(tx, env, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE tenant_id = ${env.tenantId}::uuid ORDER BY id FOR UPDATE`;
  return tx.employee.findMany({
    where: { tenant_id: env.tenantId },
    select: fields,
    orderBy: { employee_code: "asc" },
  });
}
export function employeePublic(e, rows, grades) {
  return {
    employeeCode: e.employee_code,
    category: e.employeeCategory,
    gradeCode: grades.find((g) => g.id === e.gradeLevelId)?.name || null,
    contractNoticeDays: e.contractNoticeDays,
    managerCode: rows.find((r) => r.id === e.managerId)?.employee_code || null,
    status: e.status,
    employmentStatus: e.employement_status,
    active: active(e),
    hasLogin: !!e.userId,
  };
}
export async function source(tx, env, kind, code, data, remote) {
  const rows = await employees(tx, env, true),
    grades = await tx.gradeLevel.findMany({
      where: { tenantId: env.tenantId },
    });
  if (kind === "POLICY") {
    const policy = await tx.separationPolicy.findUnique({
      where: { tenantId: env.tenantId },
    });
    return {
      fingerprint: hash(
        policy ? { version: policy.version, policy: policy.policy } : null,
      ),
      public: {
        activeVersion: policy?.version || 0,
        activePolicy: policy?.policy || null,
      },
    };
  }
  if (kind === "EMPLOYEE_SETUP") {
    const e = rows.find((r) => r.employee_code === code);
    if (!e) fail("Employee code not found in this company", 404);
    return {
      fingerprint: hash(e),
      affectedUserId: e.userId,
      public: employeePublic(e, rows, grades),
    };
  }
  remote ||= await companySetupSnapshot();
  const account = remote.accounts.find(
    (a) => a.login.toLowerCase() === data.login.toLowerCase(),
  );
  if (!account)
    fail("Login has no account membership or mapping in this company", 404);
  const target = data.employeeCode
    ? rows.find((e) => e.employee_code === data.employeeCode)
    : null;
  if (data.employeeCode && !target)
    fail("Target employee code not found in this company", 404);
  const linked = rows.filter((e) => e.userId === account.userId);
  return {
    fingerprint: hash({
      account: account.fingerprint,
      target: target
        ? {
            id: target.id,
            code: target.employee_code,
            userId: target.userId,
            active: active(target),
          }
        : null,
      linked: linked.map((e) => ({ id: e.id, code: e.employee_code })),
    }),
    account,
    affectedUserId: account.userId,
    target: target
      ? {
          id: target.id,
          code: target.employee_code,
          userId: target.userId,
          active: active(target),
        }
      : null,
    linked: linked.map((e) => ({ id: e.id, code: e.employee_code })),
    public: {
      login: account.login,
      enabled: account.enabled,
      member: account.member,
      mappedCode:
        rows.find((e) => e.id === account.hrEmployeeId)?.employee_code || null,
      primaryCodes: linked.map((e) => e.employee_code),
      mappingOutsideCompany:
        !!account.hrEmployeeId &&
        !rows.some((e) => e.id === account.hrEmployeeId),
      targetCode: data.employeeCode || null,
    },
  };
}
export function validateEmployee(data, e, rows) {
  if (
    data.category &&
    e.employeeCategory &&
    data.category !== e.employeeCategory
  )
    fail(
      "Use the category conversion workflow to change an existing category",
      409,
    );
  if (data.managerCode) {
    let manager = rows.find((r) => r.employee_code === data.managerCode),
      seen = new Set([e.id]);
    if (!manager || !active(manager))
      fail("Choose an active manager in this company");
    while (manager) {
      if (seen.has(manager.id)) fail("Reporting line would create a cycle");
      seen.add(manager.id);
      manager = rows.find((r) => r.id === manager.managerId);
    }
  }
  if (
    data.statusResolution &&
    active({ ...e, status: e.status, employement_status: e.status }) ===
      active({
        ...e,
        status: e.employement_status,
        employement_status: e.employement_status,
      })
  )
    fail(
      "Status resolution is only for conflicting status fields. Use the employee lifecycle workflow for other changes.",
      409,
    );
}
export function identityIssues(rows, remote) {
  return remote.accounts.flatMap((a) => {
    const mapped = rows.find((e) => e.id === a.hrEmployeeId),
      linked = rows.filter((e) => e.userId === a.userId),
      issues = [];
    if (a.hrEmployeeId && !mapped)
      issues.push("Mapping points outside the selected company");
    if (a.member && !a.employeeCode)
      issues.push("Account mapping has no employee code");
    if (mapped?.userId && mapped.userId !== a.userId)
      issues.push("Another login is the employee primary account");
    if (mapped && a.employeeCode && mapped.employee_code !== a.employeeCode)
      issues.push("Mapped employee code and record disagree");
    if (mapped && mapped.userId !== a.userId)
      issues.push("HR primary account does not match");
    if (linked.length > 1)
      issues.push("Login is linked to multiple employee records");
    if (a.member && !mapped && !linked.length)
      issues.push("Company account has no verified employee mapping");
    if (!a.member && (mapped || linked.length))
      issues.push("Employee link has no company membership");
    return issues.length
      ? [
          {
            login: a.login,
            employeeCode:
              mapped?.employee_code || linked[0]?.employee_code || null,
            issues,
          },
        ]
      : [];
  });
}
export async function readiness(tx, env, row, remote) {
  const blockers = [],
    payload = unseal(row.payload).data;
  if (row.kind !== "POLICY") return blockers;
  const rows = await employees(tx, env),
    grades = await tx.gradeLevel.findMany({
      where: { tenantId: env.tenantId },
    }),
    p = payload.policy;
  for (const e of rows.filter(active)) {
    const label = e.employee_code || "Employee without a code",
      grade = grades.find((g) => g.id === e.gradeLevelId)?.name;
    if (!e.employeeCategory)
      blockers.push(`${label}: employment category missing`);
    if (!grade) blockers.push(`${label}: grade missing`);
    const managementAuthority =
      e.employeeCategory === "MANAGEMENT" &&
      p.authority?.some((a) => a.approverCodes.includes(e.employee_code));
    if (
      (!e.managerId && !managementAuthority) ||
      (e.managerId && !rows.some((m) => m.id === e.managerId && active(m)))
    )
      blockers.push(`${label}: active line manager missing`);
    let manager = e,
      seen = new Set();
    while (manager) {
      if (seen.has(manager.id)) {
        blockers.push(`${label}: reporting-line cycle requires correction`);
        break;
      }
      seen.add(manager.id);
      manager = rows.find((m) => m.id === manager.managerId);
    }
    if (
      e.contractNoticeDays == null &&
      !p.noticeByGrade?.some(
        (n) => n.category === e.employeeCategory && n.gradeCode === grade,
      )
    )
      blockers.push(`${label}: contract notice or grade notice rule missing`);
    if (
      !p.authority?.some(
        (a) => a.category === e.employeeCategory && a.gradeCode === grade,
      )
    )
      blockers.push(`${label}: Management authority rule missing`);
  }
  const roles = [
    ...(p.hrCodes || []).map((code) => [code, "hr.separation.verify"]),
    ...new Set(p.authority?.flatMap((a) => a.approverCodes) || []),
  ].map((x) => (Array.isArray(x) ? x : [x, "hr.separation.approve"]));
  for (const [code, permission] of roles) {
    const e = rows.find((r) => r.employee_code === code);
    if (
      !e ||
      !active(e) ||
      !remote.accounts.some(
        (a) =>
          a.userId === e.userId &&
          a.member &&
          a.enabled &&
          a.permissions.includes(permission),
      )
    )
      blockers.push(`${code}: active account with ${permission} required`);
  }
  for (const code of new Set(
    [
      p.itOwnerCode,
      p.payrollOwnerCode,
      ...(p.clearanceDepartments || []).flatMap((d) => [
        d.ownerCode,
        ...d.signerCodes,
      ]),
    ].filter(Boolean),
  ))
    if (!rows.some((e) => e.employee_code === code && active(e) && e.userId))
      blockers.push(`${code}: active linked clearance owner required`);
  if (identityIssues(rows, remote).length)
    blockers.push(
      "Resolve company identity clarifications before policy activation",
    );
  if (
    rows.some(
      (e) =>
        !!e.status &&
        !!e.employement_status &&
        active({ ...e, employement_status: e.status }) !==
          active({ ...e, status: e.employement_status }),
    )
  )
    blockers.push("Resolve conflicting employee status fields");
  return [...new Set(blockers)];
}
export async function overview(tx, env, remote) {
  const rows = await employees(tx, env),
    grades = await tx.gradeLevel.findMany({
      where: { tenantId: env.tenantId },
      orderBy: { name: "asc" },
    });
  const people = rows.map((e) => employeePublic(e, rows, grades));
  return json({
    activePolicy:
      (
        await tx.separationPolicy.findUnique({
          where: { tenantId: env.tenantId },
        })
      )?.policy || null,
    employees: people,
    grades: grades.map((g) => ({ code: g.name, description: g.description })),
    departments: remote?.departments || [],
    identityCases: remote ? identityIssues(rows, remote) : [],
    accounts: remote
      ? remote.accounts.map((a) => ({
          login: a.login,
          employeeCode:
            rows.find((e) => e.id === a.hrEmployeeId)?.employee_code || null,
          enabled: a.enabled,
          member: a.member,
        }))
      : [],
    identityAvailable: !!remote,
    identityWarning: remote
      ? null
      : "Account service unavailable. Identity review and policy activation are blocked until it recovers.",
    counts: {
      employees: rows.length,
      missingCategory: rows.filter((e) => !e.employeeCategory).length,
      missingGrade: rows.filter((e) => !e.gradeLevelId).length,
      missingNotice: rows.filter((e) => e.contractNoticeDays == null).length,
      missingManager: rows.filter((e) => !e.managerId).length,
    },
  });
}
