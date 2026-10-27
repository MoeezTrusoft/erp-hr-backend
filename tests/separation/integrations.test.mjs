import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.NODE_ENV = "test";
const { deliverEmploymentRequest } =
  await import("../../src/services/separation/integrations.js");
const tenantId = randomUUID(),
  employeeCode = "EMP-0700";
const delivery = {
  tenantId,
  employeeCode,
  key: "fictional-delivery:1",
  kind: "FETCH_ASSETS",
  payload: { separationRef: randomUUID() },
};
test("source integration pins authenticated HTTPS and validates company and code", async () => {
  await assert.rejects(
    deliverEmploymentRequest(delivery, { environment: {} }),
    (e) => e.status === 503,
  );
  await assert.rejects(
    deliverEmploymentRequest(delivery, {
      environment: {
        HR_SEPARATION_ASSETS_URL: "http://example.test/source",
        HR_SEPARATION_ASSETS_TOKEN: "fixture",
      },
    }),
    /HTTPS/,
  );
  const environment = {
    HR_SEPARATION_ASSETS_URL: "https://example.test/source",
    HR_SEPARATION_ASSETS_TOKEN: "fictional-token",
  };
  let sent;
  const fetchImpl = async (url, options) => {
    sent = options;
    return {
      ok: true,
      json: async () => ({ companyUuid: tenantId, employeeCode, assets: [] }),
    };
  };
  await deliverEmploymentRequest(delivery, { environment, fetchImpl });
  assert.equal(sent.headers["idempotency-key"], delivery.key);
  assert.equal(sent.redirect, "error");
  assert.equal(JSON.parse(sent.body).employeeCode, employeeCode);
  await assert.rejects(
    deliverEmploymentRequest(delivery, {
      environment,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ companyUuid: randomUUID(), employeeCode }),
      }),
    }),
    /wrong company/,
  );
});
test("Communication adapter uses its shared notification contract and deduplication key", async () => {
  let body;
  await deliverEmploymentRequest(
    {
      ...delivery,
      kind: "NOTIFICATION",
      payload: {
        ...delivery.payload,
        recipients: [{ email: "fictional@example.test" }],
        messageCode: "APPROVED",
      },
    },
    {
      environment: {
        HR_SEPARATION_NOTIFICATION_URL: "https://example.test/notify",
        HR_SEPARATION_NOTIFICATION_TOKEN: "fixture",
      },
      fetchImpl: async (_, options) => {
        body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ notificationId: randomUUID() }),
        };
      },
    },
  );
  assert.equal(body.dedupeKey, delivery.key);
  assert.equal(body.data.employeeCode, employeeCode);
  assert.equal(body.tenantId, tenantId);
  assert.ok(!JSON.stringify(body).includes("documentContents"));
});
