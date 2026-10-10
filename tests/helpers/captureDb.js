import { randomUUID } from "node:crypto";

// In-memory transaction boundary for behavioural tests. Production SQL/RLS is
// require a PostgreSQL integration environment; this fixture proves application rollback and replay.
export const TENANT = "10000000-0000-4000-8000-000000000001";
export const OTHER_TENANT = "20000000-0000-4000-8000-000000000002";
const copy = (value) => {
  if (value == null || typeof value !== "object") return value;
  if (Object.prototype.toString.call(value) === "[object Date]")
    return new Date(+value);
  if (Array.isArray(value)) return value.map(copy);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, copy(v)]),
  );
};
const equal = (a, b) =>
  a instanceof Date || b instanceof Date
    ? +new Date(a) === +new Date(b)
    : a === b;
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === "OR") return value.some((w) => matches(row, w));
    if (key === "AND") return value.every((w) => matches(row, w));
    if (key === "NOT") return !matches(row, value);
    if (
      key.includes("_") &&
      value &&
      typeof value === "object" &&
      !Object.keys(value).some((k) =>
        ["in", "notIn", "gte", "lte", "not"].includes(k),
      )
    )
      return matches(row, value);
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date))
      return Object.entries(value).every(([op, v]) => {
        if (op === "in") return v.some((x) => equal(actual, x));
        if (op === "notIn") return !v.some((x) => equal(actual, x));
        if (op === "not") return !equal(actual, v);
        if (op === "gte") return actual >= v;
        if (op === "gt") return actual > v;
        if (op === "lte") return actual <= v;
        if (op === "lt") return actual < v;
        return equal(actual?.[op], v);
      });
    return equal(actual ?? null, value);
  });
}
export function captureDb(seed = {}, hooks = {}) {
  let state = copy({
    attendanceCaptureDevice: [
      {
        id: randomUUID(),
        tenantId: TENANT,
        sn: "DEVICE-1",
        name: "Reception",
        timeZone: "Asia/Karachi",
        allowedTenantIds: [TENANT, OTHER_TENANT],
        active: true,
        staleAfterMinutes: 30,
      },
    ],
    employeeDeviceEnrolment: [
      {
        id: 10,
        tenantId: TENANT,
        employeeId: 1,
        deviceUserId: "101",
        sn: "DEVICE-1",
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: null,
      },
    ],
    employee: [{ id: 1, tenant_id: TENANT, employee_code: "EMP1" }],
    attendanceCaptureReceipt: [],
    attendanceCaptureEvent: [],
    attendanceCaptureAudit: [],
    attendanceBiometricProfile: [],
    attendanceBiometricChallenge: [],
    attendanceDevicePunch: [],
    attendance: [],
    attendanceSession: [],
    attendanceEvaluation: [],
    attendanceEvaluationJob: [],
    attendanceEvaluationCursor: [],
    attendanceTimeCredit: [],
    payrollRun: [],
    overtimeRequest: [],
    outboxEvent: [],
    attendanceImportBatch: [],
    leave: [],
    attendanceAnomaly: [],
    attendanceSetupRelease: [],
    shiftAssignment: [],
    leaveRequest: [],
    attendanceCallIn: [],
    ...seed,
  });
  const calls = [];
  const db = {};
  const find = (model, args) => {
    let rows = state[model].filter((r) => matches(r, args.where));
    const order = Array.isArray(args.orderBy)
      ? args.orderBy
      : args.orderBy
        ? [args.orderBy]
        : [];
    rows.sort((a, b) => {
      for (const item of order) {
        const [key, dir] = Object.entries(item)[0];
        if (a[key] < b[key]) return dir === "asc" ? -1 : 1;
        if (a[key] > b[key]) return dir === "asc" ? 1 : -1;
      }
      return 0;
    });
    return rows.slice(
      args.skip || 0,
      args.take == null ? undefined : (args.skip || 0) + args.take,
    );
  };
  const create = (model, data) => {
    const now = new Date();
    const row = {
      id: randomUUID(),
      manually_corrected: false,
      currentApprovalLevel: 1,
      workflowVersion: 0,
      active: true,
      attempts: 0,
      version: 1,
      cursor: 0,
      state: model === "attendanceImportBatch" ? "PREVIEW" : model === "attendanceTimeCredit" ? "APPROVED" : "PENDING",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      updated_at: now,
      ...copy(data),
    };
    state[model].push(row);
    return copy(row);
  };
  const update = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined)
        row[key] =
          value?.increment != null
            ? (row[key] || 0) + value.increment
            : copy(value);
    }
    row.updated_at = new Date(Math.max(Date.now(), +row.updated_at + 1));
    return copy(row);
  };
  for (const model of Object.keys(state)) {
    const methods = {
      findMany: (args = {}) => copy(find(model, args)),
      findFirst: (args = {}) => copy(find(model, args)[0] || null),
      findUnique: (args = {}) => copy(find(model, args)[0] || null),
      count: (args = {}) => find(model, args).length,
      create: ({ data }) => create(model, data),
      createMany: ({ data, skipDuplicates }) => {
        let count = 0;
        for (const row of data) {
          if (
            skipDuplicates &&
            state[model].some((r) =>
              row.fingerprint != null
                ? r.fingerprint === row.fingerprint
                : row.employeeId != null &&
                  r.employeeId === row.employeeId &&
                  r.tenantId === row.tenantId &&
                  equal(r.date, row.date),
            )
          )
            continue;
          create(model, row);
          count++;
        }
        return { count };
      },
      update: ({ where, data }) => {
        const row = find(model, { where })[0];
        if (!row) throw new Error("Record not found");
        return update(row, data);
      },
      updateMany: ({ where, data }) => {
        const rows = find(model, { where });
        rows.forEach((r) => update(r, data));
        return { count: rows.length };
      },
      deleteMany: ({where}) => {
        const rows=find(model,{where});
        state[model]=state[model].filter(r=>!rows.includes(r));
        return {count:rows.length};
      },
    };
    db[model] = Object.fromEntries(
      Object.entries(methods).map(([method, fn]) => [
        method,
        async (args) => {
          calls.push({ model, method, args: copy(args) });
          await hooks.before?.(model, method, args);
          return fn(args);
        },
      ]),
    );
  }
  db.$executeRaw = async () => 1;
  db.$queryRaw = async (strings, ...values) => {
    if (String(strings.sql || strings.join?.("") || "").includes("pg_try_advisory"))
      return [{ acquired: true }];
    if (String(strings?.sql || strings.join?.('') || '').includes('attendance_evaluation_jobs'))
      return copy(state.attendanceEvaluationJob.filter(e=>['PENDING','FAILED'].includes(e.state)&&
        new Date(e.nextAttemptAt)<=new Date(values[0]||strings.values?.[0])).slice(0,1));
    return copy(
      state.attendanceCaptureEvent
        .filter(
          (e) =>
            ["PENDING", "FAILED"].includes(e.state) &&
            e.attempts < 8 &&
            e.nextAttemptAt <= values[0],
        )
        .slice(0, 1),
    );
  };
  db.$transaction = async (fn) => {
    const before = copy(state);
    const { $transaction, ...tx } = db;
    try {
      return await fn(tx);
    } catch (e) {
      state = before;
      throw e;
    }
  };
  db.snapshot = () => copy(state);
  db.calls = calls;
  return db;
}
