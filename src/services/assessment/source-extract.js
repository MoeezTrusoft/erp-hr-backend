import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkEvidenceEvent } from "@trusoft/contracts/assessment";
import { WorkOpportunityEvent } from "@trusoft/contracts/assessment-pm";
import prisma from "../../lib/prisma.js";
import { mcpCtx } from "../../lib/requestContext.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { config, fail, hash, json, exception } from "./base.js";

// Configuration selects data fields, never executable expressions or remote URLs.
const path = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/)
  .refine(
    (v) =>
      !v
        .split(".")
        .some((p) => ["__proto__", "prototype", "constructor"].includes(p)),
  );
const Field = z.union([
  path,
  z
    .object({
      constant: z.union([
        z.string().max(500),
        z.number().finite(),
        z.boolean(),
      ]),
    })
    .strict(),
]);
const fields = [
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
  "substantive",
  "nonroutine",
];
export const SourceExtract = z
  .object({
    kind: z.enum(["EVIDENCE", "OPPORTUNITY"]).default("EVIDENCE"),
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,49}$/),
    intervalMinutes: z.number().int().min(1).max(1440).default(5),
    recordsPath: path.default("items"),
    nextCursorPath: path.default("nextCursor"),
    checkpointPath: path.default("checkpoint"),
    mapping: z
      .object({
        companyUuid: path,
        eventId: path.optional(),
        ...Object.fromEntries(fields.map((f) => [f, Field.optional()])),
        contributors: z
          .object({
            path,
            employeeCode: path,
            role: Field,
            individualEffortMinutes: path.optional(),
          })
          .strict(),
        timing: z
          .partialRecord(
            z.enum([
              "start",
              "end",
              "timezone",
              "clockBasis",
              "individualEffortMinutes",
              "waits",
              "workingIntervals",
              "acceptedUnits",
              "attempts",
              "reworkMinutes",
              "reworkIncluded",
              "unit",
              "complexity",
              "technology",
              "context",
            ]),
            Field,
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.kind !== "OPPORTUNITY" || !v.mapping,
    "Opportunity extracts use the strict canonical work-opportunity contract",
  );

export function fieldAt(record, selector) {
  if (selector && typeof selector === "object") return selector.constant;
  if (!selector) return undefined;
  return selector
    .split(".")
    .reduce(
      (value, key) =>
        value != null && Object.hasOwn(value, key) ? value[key] : undefined,
      record,
    );
}
export function normalizeSourceRecord(record, source, extract, companyUuid) {
  let value = record;
  if (extract.mapping) {
    const m = extract.mapping;
    const contributors = fieldAt(record, m.contributors.path);
    if (!Array.isArray(contributors))
      fail("SOURCE_ATTRIBUTION", "Source contribution records are required");
    value = {
      companyUuid: fieldAt(record, m.companyUuid),
      source: source.source,
      ...Object.fromEntries(
        fields
          .map((f) => [f, fieldAt(record, m[f])])
          .filter(([, v]) => v !== undefined),
      ),
      contributors: contributors.map((c) => ({
        employeeCode: fieldAt(c, m.contributors.employeeCode),
        role: fieldAt(c, m.contributors.role),
        ...(m.contributors.individualEffortMinutes
          ? {
              individualEffortMinutes: fieldAt(
                c,
                m.contributors.individualEffortMinutes,
              ),
            }
          : {}),
      })),
      ...(m.timing
        ? {
            timing: Object.fromEntries(
              Object.entries(m.timing)
                .map(([k, v]) => [k, fieldAt(record, v)])
                .filter(([, v]) => v !== undefined),
            ),
          }
        : {}),
    };
    // A stable source revision/action yields the same event ID on retry/backfill.
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          value.companyUuid,
          source.source,
          value.sourceRecordId,
          value.sourceVersion,
          value.action,
        ]),
      )
      .digest("hex");
    value.eventId = m.eventId
      ? fieldAt(record, m.eventId)
      : `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  }
  const result = (
    extract.kind === "OPPORTUNITY" ? WorkOpportunityEvent : WorkEvidenceEvent
  ).parse(value);
  if (result.companyUuid !== companyUuid || result.source !== source.source)
    fail(
      "SOURCE_SCOPE",
      "Extract record company and source must match the approved register",
      403,
    );
  return result;
}

export async function fetchSourcePage(
  source,
  extract,
  state,
  companyUuid,
  { fetchImpl = globalThis.fetch, environment = process.env } = {},
) {
  const prefix = `HR_ASSESSMENT_SOURCE_${extract.key}`;
  const configured = environment[`${prefix}_URL`],
    token = environment[`${prefix}_TOKEN`];
  if (!configured || !token)
    fail(
      "SOURCE_CONFIGURATION",
      "Source endpoint and scoped credential are not configured",
    );
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    fail(
      "SOURCE_ENDPOINT",
      "Use a trusted HTTPS endpoint without embedded credentials",
    );
  url.searchParams.set("companyUuid", companyUuid);
  url.searchParams.set("limit", "100");
  if (state.cursor) url.searchParams.set("cursor", state.cursor);
  if (state.checkpoint) url.searchParams.set("since", state.checkpoint);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10000),
  });
  if (
    !response.ok ||
    !/application\/json/i.test(response.headers.get("content-type") || "")
  )
    fail("SOURCE_RESPONSE", "Source did not return an accepted JSON response");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024)
      fail(
        "SOURCE_RESPONSE_SIZE",
        "Extract page exceeds the configured size limit",
      );
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("SOURCE_RESPONSE", "Source returned invalid JSON");
  }
  const records = fieldAt(body, extract.recordsPath);
  if (!Array.isArray(records) || records.length > 100)
    fail("SOURCE_PAGE", "Extract pages must contain at most 100 records");
  const cursorSchema = z.string().min(1).max(1000).nullable().optional();
  const nextCursor =
    cursorSchema.parse(fieldAt(body, extract.nextCursorPath)) || null;
  const checkpoint =
    cursorSchema.parse(fieldAt(body, extract.checkpointPath)) ||
    state.checkpoint ||
    null;
  if (nextCursor && nextCursor === state.cursor)
    fail("SOURCE_CURSOR", "Source repeated its page cursor");
  return {
    events: records.map((r) =>
      normalizeSourceRecord(r, source, extract, companyUuid),
    ),
    nextCursor,
    checkpoint,
  };
}

export async function runSourceExtracts(env, dependencies = {}) {
  const db = dependencies.db || prisma;
  const transact =
    dependencies.transact ||
    ((fn) =>
      tenantTransaction(db, fn, {
        tenantId: env.tenantId,
        txOptions: { isolationLevel: "Serializable" },
      }));
  const cfg = await transact((tx) => config(tx, env.tenantId));
  if (cfg.policy.stage === "FOUNDATION") return;
  const jobs = (cfg.sourceRegister || [])
    .filter((s) => s.enabled)
    .flatMap((source) =>
      (source.extracts || []).map((raw) => ({ source, raw })),
    );
  const execute = async ({ source, raw }) => {
    const extract = SourceExtract.parse(raw),
      key = `${source.source}:${extract.key}`,
      lease = randomUUID();
    const claimed = await transact(async (tx) => {
      if (
        await tx.assessmentException.findFirst({
          where: {
            tenantId: env.tenantId,
            key: `source:${source.source}`,
            kind: "CIRCUIT_BREAKER",
            status: "OPEN",
          },
        })
      )
        return null;
      const where = {
        tenantId_kind_key: {
          tenantId: env.tenantId,
          kind: "SOURCE_CURSOR",
          key,
        },
      };
      const row = await tx.assessmentIntegration.upsert({
        where,
        create: {
          tenantId: env.tenantId,
          employeeCode: source.ownerCode,
          sourceRef: key,
          kind: "SOURCE_CURSOR",
          key,
          status: "ACTIVE",
          payload: {},
        },
        update: {},
      });
      if (
        Date.parse(row.payload.nextAttemptAt) > +env.now ||
        Date.parse(row.payload.leaseUntil) > +env.now
      )
        return null;
      const result = await tx.assessmentIntegration.updateMany({
        where: { id: row.id, tenantId: env.tenantId, sequence: row.sequence },
        data: {
          sequence: { increment: 1 },
          payload: {
            ...row.payload,
            lease,
            leaseUntil: new Date(+env.now + 60000).toISOString(),
          },
        },
      });
      return result.count === 1 ? row : null;
    });
    if (!claimed) return;
    try {
      const page = await fetchSourcePage(
        source,
        extract,
        claimed.payload,
        env.tenantId,
        dependencies,
      );
      await transact(async (tx) => {
        const current = await config(tx, env.tenantId);
        if (current.version !== cfg.version)
          fail(
            "SOURCE_CONFIGURATION_CHANGED",
            "Source configuration changed during extraction",
          );
        const row = await tx.assessmentIntegration.findFirst({
          where: { id: claimed.id, tenantId: env.tenantId },
        });
        if (row.payload.lease !== lease)
          fail("SOURCE_LEASE", "Extract lease changed");
        for (const e of page.events) {
          const old = await tx.assessmentInboxEvent.findUnique({
            where: {
              tenantId_eventId: {
                tenantId: env.tenantId,
                eventId: e.eventId,
              },
            },
          });
          if (old && hash(old.payload) !== hash(e))
            fail(
              "IDEMPOTENCY_CONFLICT",
              "Source revision content changed without a new version",
            );
          if (!old)
            await tx.assessmentInboxEvent.create({
              data: {
                tenantId: env.tenantId,
                eventId: e.eventId,
                source: source.source,
                payload: json(e),
              },
            });
        }
        await tx.assessmentIntegration.update({
          where: { id: row.id },
          data: {
            status: "ACTIVE",
            sequence: { increment: 1 },
            payload: json({
              cursor: page.nextCursor,
              checkpoint: page.nextCursor
                ? claimed.payload.checkpoint
                : page.checkpoint,
              lastSuccessAt: env.now,
              attempts: 0,
              nextAttemptAt: new Date(
                +env.now +
                  (page.nextCursor ? 0 : extract.intervalMinutes * 60000),
              ),
            }),
          },
        });
        await tx.assessmentAutomationRun.create({
          data: {
            tenantId: env.tenantId,
            runKey: `extract:${lease}`,
            policyVersion: cfg.version,
            kind: "SOURCE_EXTRACT",
            inputDigest: hash(page.events),
            inputs: {
              source: source.source,
              extractKey: extract.key,
              eventIds: page.events.map((e) => e.eventId),
            },
            actions: {
              queued: page.events.length,
              morePages: !!page.nextCursor,
            },
            outcome: "QUEUED",
          },
        });
        await tx.assessmentException.updateMany({
          where: {
            tenantId: env.tenantId,
            key: `extract:${key}`,
            status: "OPEN",
          },
          data: { status: "RESOLVED", resolvedAt: env.now },
        });
      });
    } catch (error) {
      await transact(async (tx) => {
        const row = await tx.assessmentIntegration.findFirst({
          where: { id: claimed.id, tenantId: env.tenantId },
        });
        if (row?.payload.lease !== lease) return;
        const attempts = (claimed.payload.attempts || 0) + 1;
        await tx.assessmentIntegration.update({
          where: { id: row.id },
          data: {
            status: "RETRY",
            sequence: { increment: 1 },
            payload: {
              ...claimed.payload,
              attempts,
              lastErrorCode: error.code || "SOURCE_EXTRACT_FAILED",
              nextAttemptAt: new Date(
                +env.now +
                  Math.min(900000, 2 ** Math.min(attempts, 10) * 15000),
              ).toISOString(),
            },
          },
        });
        await exception(
          tx,
          env,
          `extract:${key}`,
          "SOURCE_EXTRACT",
          source.ownerCode,
          {
            source: source.source,
            extractKey: extract.key,
            attempts,
            code: error.code || "SOURCE_EXTRACT_FAILED",
          },
          "SOURCE_OWNER",
        );
      });
    }
  };
  const failures = [];
  for (let i = 0; i < jobs.length; i += 4) {
    const results = await Promise.allSettled(jobs.slice(i, i + 4).map(execute));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) failures.push(failed.reason);
  }
  if (failures.length) throw failures[0];
}
export async function runSourceExtractionSweep() {
  const companies = await mcpCtx.run(
    { system: true },
    async () =>
      await prisma.assessmentConfiguration.findMany({
        select: { tenantId: true },
      }),
  );
  const failures = [];
  for (let i = 0; i < companies.length; i += 4) {
    const results = await Promise.allSettled(
      companies.slice(i, i + 4).map(({ tenantId }) =>
        mcpCtx.run(
          { user: { tenantId } },
          async () =>
            await runSourceExtracts({
              tenantId,
              now: new Date(),
              who: { principal: "assessment-extractor", employeeCode: null },
            }),
        ),
      ),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed) failures.push(failed.reason);
  }
  if (failures.length) throw failures[0];
}
