import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.NODE_ENV = "test";
const {
  SourceExtract,
  normalizeSourceRecord,
  fetchSourcePage,
  runSourceExtracts,
} = await import("../../src/services/assessment/source-extract.js");
const companyUuid = randomUUID();
const source = { source: "ITSM", ownerCode: "OWNER", enabled: true };
const event = {
  eventId: randomUUID(),
  companyUuid,
  source: "ITSM",
  sourceRecordId: "TICKET-01",
  sourceVersion: 1,
  occurredAt: new Date().toISOString(),
  workType: "NETWORK",
  action: "ACCEPTED",
  contributors: [{ employeeCode: "EMP-01", role: "EXECUTOR" }],
  qualityStatus: "ACCEPTED",
  sourceRef: "itsm:ticket:TICKET-01",
  contentHash: "a".repeat(64),
  classification: "INTERNAL",
  acceptanceVerified: true,
  executionVerified: true,
  substantive: false,
  nonroutine: false,
  taskCodes: [],
};
test("registered extracts reject tenant substitution and preserve strict code-only evidence", () => {
  const extract = SourceExtract.parse({ key: "ITSM" });
  assert.equal(
    normalizeSourceRecord(event, source, extract, companyUuid).contributors[0]
      .employeeCode,
    "EMP-01",
  );
  assert.throws(
    () =>
      normalizeSourceRecord(
        { ...event, companyUuid: randomUUID() },
        source,
        extract,
        companyUuid,
      ),
    /company and source/,
  );
  assert.throws(() =>
    normalizeSourceRecord(
      { ...event, contributors: [{ userId: 7, role: "EXECUTOR" }] },
      source,
      extract,
      companyUuid,
    ),
  );
  assert.throws(() =>
    SourceExtract.parse({ key: "ITSM", recordsPath: "items.__proto__.data" }),
  );
});
test("native field selection is repeatable and cannot execute expressions or infer employee identity", () => {
  const mapping = Object.fromEntries(
    [
      "sourceRecordId",
      "sourceVersion",
      "occurredAt",
      "workType",
      "action",
      "qualityStatus",
      "sourceRef",
      "contentHash",
      "classification",
      "acceptanceVerified",
      "executionVerified",
    ].map((k) => [k, `record.${k}`]),
  );
  const extract = SourceExtract.parse({
    key: "ITSM",
    mapping: {
      ...mapping,
      companyUuid: "record.companyUuid",
      contributors: {
        path: "record.contributors",
        employeeCode: "employeeCode",
        role: "role",
      },
    },
  });
  const a = normalizeSourceRecord(
      { record: event },
      source,
      extract,
      companyUuid,
    ),
    b = normalizeSourceRecord({ record: event }, source, extract, companyUuid);
  assert.equal(a.eventId, b.eventId);
  assert.notEqual(
    normalizeSourceRecord(
      { record: { ...event, sourceVersion: 2 } },
      source,
      extract,
      companyUuid,
    ).eventId,
    a.eventId,
  );
  assert.throws(() =>
    SourceExtract.parse({
      key: "ITSM",
      mapping: { ...extract.mapping, companyUuid: "process.env.SECRET()" },
    }),
  );
  assert.throws(() =>
    SourceExtract.parse({
      key: "ITSM",
      mapping: {
        ...extract.mapping,
        contributors: {
          ...extract.mapping.contributors,
          employeeCode: { constant: "EMP-01" },
        },
      },
    }),
  );
});
test("HTTPS scheduled extract scopes requests, bounds pages and refuses repeated cursors", async () => {
  const extract = SourceExtract.parse({ key: "ITSM" });
  const environment = {
    HR_ASSESSMENT_SOURCE_ITSM_URL: "https://source.example/accepted",
    HR_ASSESSMENT_SOURCE_ITSM_TOKEN: "test-token",
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url.searchParams.get("companyUuid"), companyUuid);
    assert.equal(url.searchParams.get("since"), "before");
    assert.equal(options.redirect, "error");
    return new Response(
      JSON.stringify({ items: [event], nextCursor: null, checkpoint: "after" }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const page = await fetchSourcePage(
    source,
    extract,
    { checkpoint: "before" },
    companyUuid,
    { fetchImpl, environment },
  );
  assert.equal(page.events.length, 1);
  assert.equal(page.checkpoint, "after");
  await assert.rejects(
    fetchSourcePage(source, extract, {}, companyUuid, {
      fetchImpl,
      environment: {
        ...environment,
        HR_ASSESSMENT_SOURCE_ITSM_URL: "http://source.example",
      },
    }),
    /HTTPS/,
  );
  await assert.rejects(
    fetchSourcePage(source, extract, { cursor: "same" }, companyUuid, {
      environment,
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [], nextCursor: "same" }), {
          headers: { "content-type": "application/json" },
        }),
    }),
    /repeated/,
  );
});
test("extract cursor advances atomically after validated ingestion and failures retain the checkpoint", async () => {
  const cfg = {
    version: 1,
    policy: { stage: "EVIDENCE_SHADOW" },
    sourceRegister: [{ ...source, extracts: [{ key: "ITSM" }] }],
  };
  let row,
    inbox = [],
    runs = [],
    exceptions = [];
  const tx = {
    assessmentConfiguration: { findUnique: async () => cfg },
    assessmentException: {
      findFirst: async () => null,
      updateMany: async () => ({}),
      upsert: async (x) => {
        exceptions.push(x);
        return x.create;
      },
    },
    assessmentIntegration: {
      upsert: async (x) =>
        (row ||= { id: randomUUID(), sequence: 0, ...x.create }),
      findFirst: async () => row,
      updateMany: async (x) => {
        row = { ...row, ...x.data, sequence: row.sequence + 1 };
        return { count: 1 };
      },
      update: async (x) => {
        row = { ...row, ...x.data, sequence: row.sequence + 1 };
        return row;
      },
    },
    assessmentInboxEvent: {
      findUnique: async (x) =>
        inbox.find((e) => e.eventId === x.where.tenantId_eventId.eventId),
      create: async (x) => inbox.push(x.data),
    },
    assessmentAutomationRun: { create: async (x) => runs.push(x.data) },
  };
  const now = new Date(),
    env = {
      tenantId: companyUuid,
      now,
      who: { principal: "test", employeeCode: null },
    };
  const deps = {
    db: tx,
    transact: async (fn) => fn(tx),
    environment: {
      HR_ASSESSMENT_SOURCE_ITSM_URL: "https://source.example",
      HR_ASSESSMENT_SOURCE_ITSM_TOKEN: "test-token",
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ items: [event], checkpoint: "accepted" }), {
        headers: { "content-type": "application/json" },
      }),
  };
  await runSourceExtracts(env, deps);
  assert.equal(row.payload.checkpoint, "accepted");
  assert.equal(inbox.length, 1);
  assert.equal(runs.length, 1);
  await runSourceExtracts({ ...env, now: new Date(+now + 3600001) }, deps);
  assert.equal(inbox.length, 1, "retry must not duplicate evidence");
  await runSourceExtracts(
    { ...env, now: new Date(+now + 7200002) },
    {
      ...deps,
      fetchImpl: async () => {
        throw new Error("source down");
      },
    },
  );
  assert.equal(row.payload.checkpoint, "accepted");
  assert.equal(row.status, "RETRY");
  assert.equal(exceptions.length, 1);
});
