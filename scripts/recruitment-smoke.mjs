// scripts/recruitment-smoke.mjs — Recruitment go-live staging smoke (plan 13.1).
//
// Runs over the HR MCP HTTP endpoint (POST <HR_SMOKE_MCP_URL>, the same
// JSON-RPC the gateway forwards), never the database, so it proves the
// deployed service, its RBAC keys and its flags together.
//
//   node scripts/recruitment-smoke.mjs            read-only (default)
//   node scripts/recruitment-smoke.mjs --write    + the end-to-end journey
//
// Read-only: tools/list must equal the release manifest
// (src/release/recruitment-tools.manifest.js), then one list call and one
// read of the first row per recruitment area. A flag-off area (503 *-DISABLED,
// HR-5031) is SKIP, not FAIL.
//
// --write: on a throwaway requisition, create -> submit -> approve through
// the HR Approval Centre (line manager, HR verifier, management: three
// distinct staging identities) -> post -> apply on the public portal ->
// screen -> schedule -> outcome -> offer -> offer approval -> send -> accept ->
// the hire handoff COMPLETED with an employee and a checklist. The requisition
// is closed (or withdrawn) afterwards whatever happened. The journey creates a
// real candidate and, on success, a real employee: run it only against a
// staging tenant (see scripts/RECRUITMENT-GOLIVE.runbook.md for the fixtures).
//
// Auth: each identity is a service JWT in x-service-authorization, either
// pre-minted (HR_SMOKE_TOKEN, HR_SMOKE_MANAGER_TOKEN, ...) or minted here with
// SERVICE_JWT_SECRET (HS256, issuer SERVICE_JWT_ISSUER, the gateway's default
// "erp-gateway"; staging must not set SERVICE_JWT_ACCEPT_HS256=false for that).
// The minted scope is the role's keys from the release manifest's role table.
//
// Output: pino lines per check and a final summary whose msg is the pass/fail
// table (`| jq -r 'select(.table) | .msg'`). Exit code 1 on any FAIL.
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import logger from "../src/lib/logger.js";
import {
    APPROVAL_CENTRE_KEYS,
    RECRUITMENT_LEGACY_TOOLS,
    RECRUITMENT_TOOL_MANIFEST,
    RECRUITMENT_TOOL_NAME_PATTERN,
    recruitmentRoleScopes,
} from "../src/release/recruitment-tools.manifest.js";

const log = logger.child({ script: "recruitment-smoke" });
const env = process.env;
const WRITE = process.argv.includes("--write");
const RUN_ID = randomUUID().slice(0, 8);
const TIMEOUT_MS = Number(env.HR_SMOKE_TIMEOUT_MS || 20000);

// ── Results ──────────────────────────────────────────────────────────────────
const rows = [];
function record(area, check, status, detail = "") {
    rows.push({ area, check, status, detail: String(detail).slice(0, 160) });
    const line = { area, check, status, detail };
    if (status === "FAIL") log.error(line, "smoke check failed");
    else log.info(line, "smoke check");
}
const table = () => {
    const width = (key) => Math.max(key.length, ...rows.map((r) => r[key].length));
    const cols = ["status", "area", "check", "detail"];
    const w = Object.fromEntries(cols.map((c) => [c, width(c)]));
    const line = (r) => cols.map((c) => String(r[c]).padEnd(w[c])).join("  ");
    return [line({ status: "STATUS", area: "AREA", check: "CHECK", detail: "DETAIL" }), ...rows.map(line)].join("\n");
};

// ── Identities ───────────────────────────────────────────────────────────────
function required(name) {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function mint({ userId, employeeId, roles, scope }) {
    const secret = env.SERVICE_JWT_SECRET;
    if (!secret) throw new Error("Set the identity's *_TOKEN, or SERVICE_JWT_SECRET to mint one");
    return jwt.sign(
        { sub: "recruitment-smoke", tid: required("HR_SMOKE_TENANT_ID"), userId, employeeId, roles, scope },
        secret,
        { algorithm: "HS256", issuer: env.SERVICE_JWT_ISSUER || "erp-gateway", audience: env.SERVICE_JWT_AUDIENCE || "internal", expiresIn: "15m" },
    );
}

/** An identity from <prefix>_TOKEN, or minted from <prefix>_USER_ID / _EMPLOYEE_ID. */
function identity(prefix, label, { roles, scope }) {
    const token = env[`${prefix}_TOKEN`];
    if (token) return { label, token };
    const userId = env[`${prefix}_USER_ID`];
    if (!userId) return null;
    return { label, token: mint({ userId, employeeId: env[`${prefix}_EMPLOYEE_ID`] ?? null, roles, scope }) };
}

// ── MCP over HTTP ────────────────────────────────────────────────────────────
let rpcId = 0;
async function rpc(who, method, params = {}) {
    const res = await fetch(required("HR_SMOKE_MCP_URL"), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2024-11-05",
            "x-mcp-internal": "true",
            "x-correlation-id": `recruitment-smoke-${RUN_ID}`,
            "x-service-authorization": `Bearer ${who.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const sse = text.match(/data:\s*(\{[\s\S]*\})/);
    let body;
    try { body = JSON.parse(sse ? sse[1] : text); } catch { body = null; }
    if (!body) throw Object.assign(new Error(`HTTP ${res.status}: not JSON-RPC`), { status: res.status });
    if (body.error) throw Object.assign(new Error(body.error.message), { status: res.status, code: body.error.data?.code });
    return body.result;
}

/** tools/call; returns the tool's JSON payload or throws its error (status, code). */
async function call(who, name, args = {}) {
    const result = await rpc(who, "tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text ?? "null";
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (result?.isError) {
        // withToolError bodies are JSON; a tool without the wrapper returns the
        // SDK's plain-text error.
        const message = typeof data === "string" ? data : data?.error ?? "tool error";
        throw Object.assign(new Error(message), { status: data?.status, code: data?.code, tool: name });
    }
    return result?.structuredContent ?? data;
}

const isFlagOff = (err) => Number(err?.status) === 503 || err?.code === "HR-5031" || /-DISABLED$/.test(String(err?.code ?? ""));
const describeErr = (err) => `${err?.code ?? err?.status ?? "error"}: ${err?.message}`;

/** The first object row of a list payload, whatever the list's wrapper. */
function firstRow(data, depth = 0) {
    if (Array.isArray(data)) return data.find((r) => r && typeof r === "object") ?? null;
    if (!data || typeof data !== "object" || depth > 2) return null;
    for (const key of ["items", "data", "rows", "results", "records"]) {
        if (Array.isArray(data[key])) return firstRow(data[key], depth + 1);
    }
    for (const value of Object.values(data)) {
        const row = firstRow(value, depth + 1);
        if (row) return row;
    }
    return null;
}
const idOf = (data) => data?.id ?? data?.data?.id ?? data?.summary?.id ?? data?.requisition?.id ?? data?.offer?.id ?? data?.interview?.id ?? null;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── Read-only checks ─────────────────────────────────────────────────────────
async function checkToolList(who) {
    const listed = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
        const result = await rpc(who, "tools/list", cursor ? { cursor } : {});
        for (const t of result?.tools ?? []) listed.add(t.name);
        cursor = result?.nextCursor;
        if (!cursor) break;
    }
    const manifest = new Set(RECRUITMENT_TOOL_MANIFEST.map((t) => t.name));
    const legacy = new Set(RECRUITMENT_LEGACY_TOOLS);
    const missing = [...manifest].filter((n) => !listed.has(n));
    const extra = [...listed].filter((n) => RECRUITMENT_TOOL_NAME_PATTERN.test(n) && !manifest.has(n) && !legacy.has(n));
    record("tools", `tools/list equals the manifest (${manifest.size})`, missing.length || extra.length ? "FAIL" : "PASS",
        missing.length || extra.length ? `missing: ${missing.join(",") || "-"}; not in manifest: ${extra.join(",") || "-"}` : `${listed.size} tools listed`);
}

const AREAS = [
    ["requisitions", "hr_requisitions_list", { pageSize: 1 }, "hr_requisition_manage_get", (r) => ({ id: String(r.id) })],
    ["candidates", "hr_candidates_list", { pageSize: 1 }, "hr_candidate_360_get", (r) => ({ candidateId: String(r.id) })],
    ["applications", "hr_application_list", { limit: 1 }, "hr_application_get", (r) => ({ id: String(r.id) })],
    ["interviews", "hr_interviews_manage_list", { pageSize: 1 }, "hr_interview_manage_get", (r) => ({ id: String(r.id) })],
    ["offers", "hr_offers_manage_list", { pageSize: 1 }, "hr_offer_manage_get", (r) => ({ id: String(r.id) })],
    ["talent pool", "hr_talent_pool_manage_list", { pageSize: 1 }, "hr_talent_pool_profile_get", (r) => ({ candidateId: String(r.candidateId ?? r.candidate?.id ?? r.id) })],
    ["handoffs", "hr_offer_handoffs_failed_list", {}, "hr_offer_handoff_get", (r) => ({ id: String(r.offerId ?? r.id) })],
    ["onboarding readiness", "hr_onboarding_readiness_list", { limit: 1 }, "hr_onboarding_readiness_get", (r) => ({ checklistId: Number(r.checklistId ?? r.id) })],
    ["IT provisioning", "hr_onboarding_provisioning_requests_list", { limit: 1 }, "hr_onboarding_provisioning_request_get", (r) => ({ requestId: Number(r.id) })],
    ["test blueprints", "hr_test_blueprints_list", { limit: 1 }, "hr_test_blueprint_get", (r) => ({ blueprintId: Number(r.id) })],
    ["agencies", "hr_recruitment_agencies_list", { pageSize: 1 }, "hr_recruitment_agency_get", (r) => ({ id: Number(r.id) })],
    ["retention runs", "hr_candidate_retention_runs_list", { limit: 1 }, "hr_candidate_retention_run_get", (r) => ({ runId: Number(r.id) })],
    ["data-subject requests", "hr_candidate_request_list", {}, null, null],
    ["analytics alerts", "hr_recruitment_alerts_list", { limit: 1 }, null, null],
    ["analytics", "hr_recruitment_analytics_get", {}, null, null],
    ["settings", "hr_recruitment_settings_get", {}, null, null],
];

async function checkAreas(who) {
    for (const [area, listTool, listArgs, getTool, getArgs] of AREAS) {
        let row;
        try {
            row = firstRow(await call(who, listTool, listArgs));
            record(area, listTool, "PASS", row ? "1 row" : "no rows");
        } catch (err) {
            record(area, listTool, isFlagOff(err) ? "SKIP" : "FAIL", isFlagOff(err) ? `flag off (${describeErr(err)})` : describeErr(err));
            continue;
        }
        if (!getTool) continue;
        if (!row) {
            record(area, getTool, "SKIP", "nothing to read");
            continue;
        }
        try {
            await call(who, getTool, getArgs(row));
            record(area, getTool, "PASS");
        } catch (err) {
            record(area, getTool, isFlagOff(err) ? "SKIP" : "FAIL", describeErr(err));
        }
    }
}

// ── The write journey ────────────────────────────────────────────────────────
const FORWARD = Object.freeze({ LINE_MANAGER: "RECOMMEND_APPROVAL", HR: "VERIFY", MANAGEMENT: "APPROVE" });

/** Find the Approval Centre request for a source and walk it to APPROVED. */
async function approveInCentre(kind, sourceRef, approvers) {
    const sources = String(sourceRef);
    let ref = null;
    let cursor;
    for (let page = 0; page < 10 && !ref; page++) {
        const result = await call(approvers.LINE_MANAGER, "hr_approval_list", { kind, scope: "QUEUE", limit: 100, ...(cursor ? { cursor } : {}) });
        ref = (result?.items ?? []).find((r) => r.sourceRef === sources)?.approvalRef ?? null;
        cursor = result?.nextCursor;
        if (!cursor) break;
    }
    if (!ref) throw new Error(`no ${kind} approval request for ${sources} in the line manager's queue`);
    for (let step = 0; step < 6; step++) {
        const stage = (await call(approvers.LINE_MANAGER, "hr_approval_read", { approvalRef: ref }))?.record?.stage;
        if (stage === "APPROVED") return ref;
        const who = approvers[stage];
        if (!FORWARD[stage] || !who) throw new Error(`approval ${ref} stopped at ${stage}`);
        const current = (await call(who, "hr_approval_read", { approvalRef: ref }))?.record;
        if (!current?.actions?.includes(FORWARD[stage])) throw new Error(`${who.label} may not ${FORWARD[stage]} at ${stage} (actions: ${current?.actions?.join(",") || "none"})`);
        await call(who, "hr_approval_action", {
            approvalRef: ref,
            expectedVersion: current.version,
            action: FORWARD[stage],
            reason: `Recruitment staging smoke ${RUN_ID}`,
            requestKey: randomUUID(),
        });
    }
    throw new Error(`approval ${ref} did not reach APPROVED`);
}

async function portalApply(requisitionId, email) {
    const base = required("HR_SMOKE_PORTAL_URL").replace(/\/+$/, "");
    const headers = { "content-type": "application/json" };
    if (env.HR_SMOKE_PORTAL_TENANT_HEADER === "true") headers["X-Portal-Tenant"] = required("HR_SMOKE_TENANT_ID");
    const job = await fetch(`${base}/public/jobs/${requisitionId}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (job.status !== 200) throw new Error(`public job detail answered ${job.status}`);
    const res = await fetch(`${base}/public/jobs/${requisitionId}/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ firstName: "Smoke", lastName: `Run ${RUN_ID}`, email, policyVersion: env.HR_SMOKE_POLICY_VERSION || "staging-smoke", source: "PORTAL" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) throw new Error(`portal apply answered ${res.status}`);
}

async function acceptOffer(offerId, who) {
    const base = (env.HR_SMOKE_REST_URL || new URL(required("HR_SMOKE_MCP_URL")).origin).replace(/\/+$/, "");
    const res = await fetch(`${base}/api/offers/${offerId}/respond`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-service-authorization": `Bearer ${who.token}` },
        body: JSON.stringify({ accepted: true, ...(env.HR_SMOKE_EMPLOYEE_CATEGORY ? { employeeCategory: env.HR_SMOKE_EMPLOYEE_CATEGORY } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`offer respond answered ${res.status} ${body?.code ?? ""} ${body?.message ?? ""}`.trim());
}

const isoDay = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const isoAt = (days) => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19)}Z`;

async function writeJourney(recruiter, approvers) {
    const employeeId = required("HR_SMOKE_EMPLOYEE_ID");
    const state = { requisitionId: null, applicationId: null, candidateId: null, offerId: null };
    const steps = [];
    const step = (name, fn) => steps.push([name, fn]);
    const extra = env.HR_SMOKE_REQUISITION_JSON ? JSON.parse(env.HR_SMOKE_REQUISITION_JSON) : {};

    step("hr_requisition_create", async () => {
        state.requisitionId = String(idOf(await call(recruiter, "hr_requisition_create", {
            title: `Recruitment smoke ${RUN_ID} (staging, do not apply)`,
            requestedById: employeeId,
            recruiterId: employeeId,
            departmentId: required("HR_SMOKE_DEPARTMENT_ID"),
            location: "Staging smoke",
            employmentType: "FULL_TIME",
            openings: 1,
            hiringReason: "NEW_HIRE",
            costCenterRef: env.HR_SMOKE_COST_CENTER_REF || "STAGING-SMOKE",
            description: "Throwaway requisition created and closed by scripts/recruitment-smoke.mjs.",
            ...extra,
        })));
        if (state.requisitionId === "null") throw new Error("no requisition id returned");
        return `requisition ${state.requisitionId}`;
    });
    step("hr_requisition_submit", async () => { await call(recruiter, "hr_requisition_submit", { id: state.requisitionId }); });
    step("approve requisition (Approval Centre)", async () => `approval ${await approveInCentre("REQUISITION", state.requisitionId, approvers)}`);
    step("hr_requisition_post", async () => { await call(recruiter, "hr_requisition_post", { id: state.requisitionId, postingChannels: ["CAREER_SITE"] }); });
    step("apply on the public portal", async () => {
        await portalApply(state.requisitionId, (env.HR_SMOKE_CANDIDATE_EMAIL || "recruitment-smoke+{run}@example.com").replace("{run}", RUN_ID));
    });
    step("find the application", async () => {
        for (let i = 0; i < 5 && !state.applicationId; i++) {
            const row = firstRow(await call(recruiter, "hr_application_list", { requisitionId: state.requisitionId, limit: 5 }));
            if (row) {
                state.applicationId = String(row.id);
                state.candidateId = String(row.candidateId ?? row.candidate?.id);
            } else await sleep(1000);
        }
        if (!state.applicationId) throw new Error("the portal application did not appear");
        return `application ${state.applicationId}`;
    });
    step("hr_application_screening_record ADVANCE", async () => { await call(recruiter, "hr_application_screening_record", { id: state.applicationId, outcome: "ADVANCE" }); });
    step("hr_interview_create", async () => {
        state.interviewId = String(idOf(await call(recruiter, "hr_interview_create", {
            applicationId: state.applicationId,
            scheduledAt: isoAt(2),
            interviewType: "FINAL",
            interviewerIds: [env.HR_SMOKE_INTERVIEWER_ID || employeeId],
            location: "Staging smoke",
        })));
        return `interview ${state.interviewId}`;
    });
    step("hr_interview_set_outcome NEXT_ROUND", async () => {
        await call(recruiter, "hr_interview_set_outcome", {
            interviewId: Number(state.interviewId),
            decision: "NEXT_ROUND",
            overrideReason: `Staging smoke ${RUN_ID}: no scorecard`,
        });
    });
    step("application to the offer stage", async () => {
        const app = await call(recruiter, "hr_application_get", { id: state.applicationId });
        const stage = String(app?.stage ?? app?.data?.stage ?? "").toLowerCase();
        if (stage !== "offer") await call(recruiter, "hr_application_update_stage", { id: state.applicationId, stage: "offer" });
        return stage === "offer" ? "already at offer" : `from ${stage || "?"}`;
    });
    step("hr_offer_create", async () => {
        state.offerId = String(idOf(await call(recruiter, "hr_offer_create", {
            applicationId: state.applicationId,
            candidateId: state.candidateId,
            jobRequisitionId: state.requisitionId,
            baseSalary: Number(env.HR_SMOKE_OFFER_SALARY || 100000),
            currency: env.HR_SMOKE_CURRENCY || "PKR",
            startDate: isoDay(30),
            expiryDate: isoDay(7),
            idempotencyKey: `recruitment-smoke-${RUN_ID}`,
        })));
        return `offer ${state.offerId}`;
    });
    step("submit the offer to the Approval Centre", async () => {
        await call(recruiter, "hr_approval_submit", {
            kind: "OFFER",
            sourceRef: state.offerId,
            employeeCode: required("HR_SMOKE_EMPLOYEE_CODE"),
            expectedVersion: 0,
            reason: `Recruitment staging smoke ${RUN_ID}`,
            requestKey: randomUUID(),
        });
    });
    step("approve offer (Approval Centre)", async () => `approval ${await approveInCentre("OFFER", state.offerId, approvers)}`);
    step("hr_offer_send", async () => { await call(recruiter, "hr_offer_send", { id: state.offerId }); });
    step("accept the offer", async () => { await acceptOffer(state.offerId, recruiter); });
    step("handoff COMPLETED", async () => {
        for (let i = 0; i < 30; i++) {
            const handoff = await call(recruiter, "hr_offer_handoff_get", { id: state.offerId });
            const h = handoff?.handoff ?? handoff?.data ?? handoff;
            if (h?.status === "FAILED") throw new Error(`handoff FAILED at ${h.lastStep ?? "?"}`);
            if (h?.status === "COMPLETED") {
                if (!h.employeeId || !h.checklistId) throw new Error("COMPLETED without an employee or checklist");
                state.employeeId = h.employeeId;
                return `employee ${h.employeeId}, checklist ${h.checklistId}`;
            }
            await sleep(2000);
        }
        throw new Error("handoff not COMPLETED within 60 s");
    });

    let failed = false;
    for (const [name, fn] of steps) {
        if (failed) {
            record("journey", name, "SKIP", "an earlier step failed");
            continue;
        }
        try {
            record("journey", name, "PASS", (await fn()) ?? "");
        } catch (err) {
            failed = true;
            record("journey", name, "FAIL", describeErr(err));
        }
    }
    return state;
}

/** Close the throwaway requisition, or withdraw it while it is still in review. */
async function cleanup(recruiter, state) {
    if (!state?.requisitionId || state.requisitionId === "null") return;
    try {
        await call(recruiter, "hr_requisition_close", { id: state.requisitionId, reason: `Recruitment staging smoke ${RUN_ID} complete` });
        record("cleanup", "hr_requisition_close", "PASS", `requisition ${state.requisitionId}`);
    } catch (closeErr) {
        try {
            await call(recruiter, "hr_requisition_withdraw", { id: state.requisitionId, reason: "RECRUITMENT_CANCELLED" });
            record("cleanup", "hr_requisition_withdraw", "PASS", `requisition ${state.requisitionId}`);
        } catch (err) {
            record("cleanup", "close or withdraw the smoke requisition", "FAIL", `${describeErr(closeErr)} / ${describeErr(err)}`);
        }
    }
    record("cleanup", "created in staging", "PASS", JSON.stringify({
        requisitionId: state.requisitionId, applicationId: state.applicationId, candidateId: state.candidateId,
        offerId: state.offerId, employeeId: state.employeeId ?? null,
    }));
}

async function main() {
    const recruiter = identity("HR_SMOKE", "smoke operator", {
        roles: (env.HR_SMOKE_ROLES || "HR_ADMIN").split(",").map((r) => r.trim()).filter(Boolean),
        scope: [...recruitmentRoleScopes("HR_ADMIN"), APPROVAL_CENTRE_KEYS.INITIATOR],
    });
    if (!recruiter) throw new Error("Set HR_SMOKE_TOKEN, or HR_SMOKE_USER_ID (+ HR_SMOKE_EMPLOYEE_ID) with SERVICE_JWT_SECRET");
    await checkToolList(recruiter);
    await checkAreas(recruiter);
    if (!WRITE) return;

    const approvers = {
        LINE_MANAGER: identity("HR_SMOKE_MANAGER", "line manager", { roles: ["HIRING_MANAGER"], scope: [APPROVAL_CENTRE_KEYS.LINE_MANAGER] }),
        HR: identity("HR_SMOKE_HR_VERIFIER", "HR verifier", { roles: ["HR_ADMIN"], scope: [APPROVAL_CENTRE_KEYS.HR_VERIFIER] }),
        MANAGEMENT: identity("HR_SMOKE_APPROVER", "management approver", { roles: ["HR_MANAGER"], scope: [APPROVAL_CENTRE_KEYS.MANAGEMENT] }),
    };
    const absent = Object.entries(approvers).filter(([, who]) => !who).map(([stage]) => stage);
    if (absent.length) {
        record("journey", "Approval Centre identities", "FAIL", `missing for ${absent.join(", ")}`);
        return;
    }
    let state;
    try {
        state = await writeJourney(recruiter, approvers);
    } finally {
        await cleanup(recruiter, state);
    }
}

let exitCode = 0;
try {
    log.info({ mode: WRITE ? "write" : "read-only", runId: RUN_ID, manifestTools: RECRUITMENT_TOOL_MANIFEST.length }, "recruitment smoke start");
    await main();
} catch (err) {
    record("smoke", "run", "FAIL", err?.message);
}
const counts = { passed: 0, failed: 0, skipped: 0 };
for (const r of rows) {
    if (r.status === "PASS") counts.passed++;
    else if (r.status === "FAIL") counts.failed++;
    else counts.skipped++;
}
if (counts.failed) exitCode = 1;
log.info({ runId: RUN_ID, ...counts, table: rows }, `recruitment smoke ${counts.failed ? "FAILED" : "passed"}\n${table()}`);
// Flush pino, then exit: fetch keep-alive sockets would otherwise hold the
// process open for a few seconds.
await new Promise((resolve) => {
    try { logger.flush(() => resolve()); } catch { resolve(); }
});
process.exit(exitCode);
