import { NotifyRequest } from "@trusoft/contracts/events";
import { SourceSnapshot } from "@trusoft/contracts/employment";
import {
  run,
  authorizedSeparation,
  fail,
  taskModels,
  createTask,
  updateTask,
  touch,
  result,
  view,
  json,
} from "./base.js";
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export async function storeSourceSnapshot(tx, env, s, input) {
  if (input.employeeCode !== s.employeeCode || input.separationRef !== s.id)
    fail("Source identity does not match the separation");
  if (new Date(input.asOf) > new Date(+env.now + 300000))
    fail("Source timestamp is in the future");
  const where = {
    tenantId: env.tenantId,
    separationRef: s.id,
    key: input.source,
  };
  const existing = await tx.separationSourceSnapshot.findFirst({ where });
  if (existing) {
    if (existing.payload.sourceVersion > input.sourceVersion)
      fail("Source version is stale", 409);
    if (existing.payload.sourceVersion === input.sourceVersion) {
      if (stable(existing.payload) !== stable(input))
        fail("Source revision was replayed with different content", 409);
      return existing;
    }
  }
  if (input.source === "ASSETS" && !input.assets)
    fail(
      "Asset snapshot must explicitly include an array, including when empty",
    );
  if (input.source === "PAYROLL" && !input.financial)
    fail("Payroll financial snapshot is required");
  if (
    input.source === "INCENTIVES" &&
    input.incentiveClawbacksMinor === undefined
  )
    fail("Explicit incentive clawback amount is required");
  const settled = await tx.finalSettlementSheet.findFirst({
    where: {
      tenantId: env.tenantId,
      separationRef: s.id,
      status: { in: ["HANDED_OFF", "COMPLETED"] },
    },
  });
  if (settled)
    fail(
      "Payroll already holds the settlement; reconcile the handoff before changing source data",
      409,
    );
  const row = existing
    ? await updateTask(tx, env, "separationSourceSnapshot", existing, {
        payload: json(input),
        evidenceRefs: input.evidenceRefs,
      })
    : await createTask(
        tx,
        env,
        s,
        "separationSourceSnapshot",
        input.source,
        input,
        s.policySnapshot.hrCodes[0],
      );
  if (input.source === "ASSETS") {
    const department =
      s.policySnapshot.clearanceDepartments.find(
        (d) => d.departmentCode === "ADMINISTRATION",
      ) ||
      s.policySnapshot.clearanceDepartments.find(
        (d) => d.departmentCode === "HR",
      );
    if (!department)
      fail("Configure Administration or HR asset custody ownership");
    for (const a of input.assets) {
      const old = await tx.assetHandoverItem.findFirst({
        where: { tenantId: env.tenantId, separationRef: s.id, key: a.assetRef },
      });
      if (old) {
        if (old.payload.serial !== a.serial)
          fail(
            "Asset serial changed; reconcile custody evidence before clearance",
            409,
          );
      } else
        await createTask(
          tx,
          env,
          s,
          "assetHandoverItem",
          a.assetRef,
          { ...a, sourceRef: input.sourceRef },
          department.ownerCode,
        );
    }
  }
  await touch(
    tx,
    env,
    s,
    "SOURCE_SYNCED",
    `${input.source} revision ${input.sourceVersion}`,
  );
  return row;
}
export const syncSource = (raw) => {
  const input = SourceSnapshot.parse(raw);
  return run(
    input,
    "hr.separation.integrate",
    async (tx, env) => {
      const s = await authorizedSeparation(tx, env, input, { lock: true });
      const { requestKey, expectedVersion, ...source } = input;
      const row = await storeSourceSnapshot(tx, env, s, source);
      return result(env, view(row, "SOURCE", row.payload));
    },
    "SOURCE_SYNC",
  );
};

// Registered integrations only: the request cannot supply a URL or credentials.
// Each endpoint receives a company/code pair and a stable idempotency key.
export async function deliverEmploymentRequest(
  delivery,
  { fetchImpl = globalThis.fetch, environment = process.env } = {},
) {
  const kind = delivery.kind.replace(/^FETCH_/, "");
  const base = environment[`HR_SEPARATION_${kind}_URL`],
    token = environment[`HR_SEPARATION_${kind}_TOKEN`];
  if (!base || !token)
    fail(`Configure HR_SEPARATION_${kind}_URL and its service credential`, 503);
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password)
    fail("Integration endpoints must use authenticated HTTPS", 503);
  const body =
    kind === "NOTIFICATION"
      ? NotifyRequest.parse({
          tenantId: delivery.tenantId,
          dedupeKey: delivery.key,
          recipients: delivery.payload.recipients,
          templateId:
            environment.HR_SEPARATION_NOTIFICATION_TEMPLATE ||
            "hr.separation.transition",
          data: {
            employeeCode: delivery.employeeCode,
            separationRef: delivery.payload.separationRef,
            messageCode: delivery.payload.messageCode,
          },
          channels: ["in_app", "email"],
          category: "hr.separation",
          entityRef: `/hr/my-separation?employeeCode=${encodeURIComponent(delivery.employeeCode)}`,
        })
      : {
          companyUuid: delivery.tenantId,
          employeeCode: delivery.employeeCode,
          ...delivery.payload,
        };
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "x-service-authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": delivery.key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) fail(`Integration returned HTTP ${response.status}`, 503);
  const data = await response.json();
  if (kind === "NOTIFICATION") {
    if (!data.notificationId)
      fail("Notification service did not confirm acceptance", 502);
    return data;
  }
  if (
    data.companyUuid !== delivery.tenantId ||
    data.employeeCode !== delivery.employeeCode
  )
    fail("Integration response has the wrong company or employee code", 502);
  return data;
}
