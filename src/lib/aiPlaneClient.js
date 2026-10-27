// src/lib/aiPlaneClient.js — [HR-AI-PLANE-01]
//
// HR's side of the ai:tasks contract (§7.1 / ARCH-04 / WBS C.7). The AI plane
// (erp-ai-plane) is the only service in the fleet permitted to hold an LLM SDK
// or provider credentials; HR XADDs a task keyed by promptKey and reads the
// result back off ai:results with a bounded wait.
//
//   ai:tasks    { taskId, tenantId, type, promptKey, input, correlationId, module }
//   ai:results  { taskId, tenantId, status, output, error?, tokensUsed }
//
// CONTRACT (Phase 2): the task is the strict AiTaskV1 of
// @trusoft/contracts/ai-tasks. It is built here and parsed with
// aiTaskStreamFields BEFORE the XADD, so a task the plane would reject (no
// `module`, a non-uuid tenant, a type outside the grammar, an extra field) fails
// in HR with a typed 400 instead of vanishing on the plane side. The earlier
// shape omitted `module` and sent "" for a missing tenant, so the plane's strict
// parse refused every HR task.
//
// LATE RESULTS: ai:results carries taskId (not the correlationId), so a result
// is matched by the taskId this client minted. When the bounded wait expires,
// runAiTask returns { pending: true, taskId, sinceId }; a caller that persists
// both can call collectAiResult later and pick the answer off the stream
// without submitting (and paying for) the task again. This holds while the
// entry is still on the stream: if the plane trims ai:results (MAXLEN) before
// collection, the result is gone and the caller must submit a new task.
//
// WHY THIS EXISTS: §7.1 says "no vendor hard-coded in HR — all Recruitment AI
// calls go through the dedicated AI service plane". resume-parsing.service.js
// previously held its own OpenAI SDK + OPENAI_API_KEY, which is exactly the
// arrangement the fleet removed everywhere else (comms TTS, DAM enrichment, PM
// planning). The plane also owns what HR cannot do in-tree: PII redaction
// (§7.1a) before any byte leaves, per-tenant token ceilings, and
// provider/residency eligibility policy (§7.1b).
//
// FAILURE POSTURE — the plane is an OPTIONAL dependency. AI features degrade;
// Recruitment itself must keep working (§7.1b: "with no approved provider
// configured, AI features stay disabled while normal Recruitment continues
// working"). Every caller therefore gets a typed 503 error (HR's
// { status, code } convention, same shape as HR-RESUME-NO-KEY) it can catch,
// never an unhandled redis exception, and the client connects lazily so a
// missing REDIS_URL cannot become a boot failure.
import { createClient } from "redis";
import crypto from "node:crypto";

import { aiTaskStreamFields } from "@trusoft/contracts/ai-tasks";

import logger from "./logger.js";

function planeError(message, code = "HR-AI-PLANE-UNAVAILABLE") {
    return Object.assign(new Error(message), { status: 503, code });
}

const TASKS_STREAM = process.env.TASKS_STREAM || "ai:tasks";
const RESULTS_STREAM = process.env.RESULTS_STREAM || "ai:results";

// How long an HR request is willing to hold open. The plane enforces its own
// per-tenant token ceiling separately.
const DEFAULT_WAIT_MS = Number(process.env.AI_TASK_WAIT_MS) || 25_000;
// One blocking read at a time, so a slow task cannot pin the connection.
const READ_BLOCK_MS = 2_000;
// A late-result scan reads at most this many ai:results entries per call.
const COLLECT_PAGE = 200;
const COLLECT_MAX_ENTRIES = 5_000;

/** The `module` every HR task carries (AiTaskV1.module). */
export const AI_TASK_MODULE = "hr";

const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

// AiTaskV1.type is dotted snake_case. Callers historically passed names such as
// "hr.candidate-match"; fold them onto the grammar instead of refusing, and fall
// back to the prompt key without its version when nothing usable is left.
export function normalizeAiTaskType(type, promptKey) {
    const folded = String(type ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, "_");
    if (TYPE_RE.test(folded) && folded.length <= 100) return folded;
    return String(promptKey ?? "").replace(/\.v\d+$/, "");
}

/**
 * Build the AiTaskV1 for a submission and flatten it to XADD fields. Throws a
 * typed 400 (HR-AI-PLANE-BAD-REQUEST) when the task is not contract-valid —
 * a non-retryable failure, so the parse ledger does not spend attempts on it.
 *
 * @returns {Record<string, string>} the stream fields
 */
export function buildAiTaskFields({ taskId, promptKey, type, tenantId, input, correlationId }) {
    const task = {
        taskId,
        tenantId: String(tenantId ?? ""),
        type: normalizeAiTaskType(type ?? promptKey, promptKey),
        promptKey,
        // The plane redacts PII from `input` before building the prompt (§7.1a).
        input: input && typeof input === "object" && !Array.isArray(input) ? input : {},
        correlationId: String(correlationId ?? taskId).slice(0, 200),
        module: AI_TASK_MODULE,
    };
    try {
        return aiTaskStreamFields(task);
    } catch (err) {
        const fields = (err?.issues ?? []).map((issue) => issue.path?.join(".")).filter(Boolean);
        throw Object.assign(new Error(`AI task is not a valid AiTaskV1 (${fields.join(", ") || "shape"})`), {
            status: 400,
            code: "HR-AI-PLANE-BAD-REQUEST",
            details: { fields },
        });
    }
}

// Decode one ai:results entry into the result shape callers consume.
function decodeResult(taskId, raw) {
    const result = {
        taskId,
        status: raw.status ?? "unknown",
        tokensUsed: raw.tokensUsed ? Number(raw.tokensUsed) : undefined,
    };
    if (raw.error) result.error = raw.error;
    if (raw.output !== undefined) {
        try {
            result.output = JSON.parse(raw.output);
        } catch {
            result.output = raw.output;
        }
        // The plane wraps the model's own text in `result`; unwrap and
        // de-fence it so consumers get structured data.
        if (result.output && typeof result.output === "object" && "result" in result.output) {
            result.output.result = extractModelJson(result.output.result);
        }
    }
    return result;
}

let clientPromise = null;

/**
 * Lazily connect. Lazy on purpose: HR must start and serve every non-AI route
 * even when REDIS_URL is absent or the plane is down.
 */
function getClient() {
    if (!process.env.REDIS_URL) {
        throw planeError("AI plane transport is not configured (REDIS_URL is unset)");
    }

    if (!clientPromise) {
        clientPromise = (async () => {
            const client = createClient({ url: process.env.REDIS_URL });
            // A connection-level error must not become an unhandled rejection and
            // take the process down; the next call reconnects.
            client.on("error", (err) => {
                logger.error({ err }, "ai-plane transport connection error");
            });
            await client.connect();
            logger.info({ tasksStream: TASKS_STREAM }, "ai-plane transport connected");
            return client;
        })().catch((err) => {
            // Reset so a transient failure does not poison every later call with
            // the same rejected promise.
            clientPromise = null;
            throw planeError(`AI plane transport failed: ${err?.message ?? err}`);
        });
    }
    return clientPromise;
}

/** Exposed for tests and for a graceful shutdown path. */
export async function closeAiPlaneTransport() {
    if (!clientPromise) return;
    try {
        const client = await clientPromise;
        await client.quit();
    } catch {
        // Already gone; nothing to release.
    } finally {
        clientPromise = null;
    }
}

/**
 * Pull the JSON out of a model response — same contract as PM's
 * [PM-AI-PLAN-FENCED-JSON-01]: the plane's envelope parses, but the model's own
 * text can arrive inside as a ```json fenced block or wrapped in prose.
 * Returns the parsed value, or `{ raw }` when it genuinely is not JSON — never
 * throws, because a model that answered in prose should not lose the answer.
 */
export function extractModelJson(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== "string") return value;

    const trimmed = value.trim();

    // ```json … ``` or ``` … ```
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;

    try {
        return JSON.parse(candidate);
    } catch {
        // Last resort: the model wrapped JSON in a sentence. Take the outermost
        // brace-delimited span rather than giving up on the whole answer.
        const first = candidate.indexOf("{");
        const last = candidate.lastIndexOf("}");
        if (first !== -1 && last > first) {
            try {
                return JSON.parse(candidate.slice(first, last + 1));
            } catch {
                // fall through
            }
        }
        return { raw: value };
    }
}

/**
 * Submit a task to the plane and wait for its result.
 *
 * @returns {{taskId:string, status:string, output?:any, error?:string,
 *            tokensUsed?:number, pending?:boolean, sinceId?:string}}
 *   `pending: true` means the wait window expired, NOT that the task failed —
 *   the result will still land on ai:results; pass `taskId` and `sinceId` to
 *   collectAiResult to pick it up later.
 */
export async function runAiTask({ promptKey, type, tenantId, input, correlationId, waitMs } = {}) {
    if (!promptKey) throw planeError("promptKey is required", "HR-AI-PLANE-BAD-REQUEST");

    const taskId = crypto.randomUUID();
    // Validate before touching the transport: a malformed task is our bug, and
    // it must not look like a plane outage.
    const fields = buildAiTaskFields({ taskId, promptKey, type, tenantId, input, correlationId });

    const client = await getClient();

    // Capture the results cursor BEFORE publishing. Reading from '$' after the
    // XADD would race: a fast plane can answer before we start listening, and
    // that result would never be seen.
    let cursor = "$";
    try {
        const info = await client.xInfoStream(RESULTS_STREAM);
        cursor = info.lastGeneratedId ?? "$";
    } catch {
        // Stream does not exist yet — '$' is correct, there is nothing earlier.
    }
    // Where a later collectAiResult scan starts: the entry before our task.
    const sinceId = cursor === "$" ? "-" : cursor;

    await client.xAdd(TASKS_STREAM, "*", fields);

    logger.info({ taskId, promptKey, tenantId }, "hr ai task submitted");

    const deadline = Date.now() + (waitMs ?? DEFAULT_WAIT_MS);
    while (Date.now() < deadline) {
        const response = await client.xRead({ key: RESULTS_STREAM, id: cursor }, { BLOCK: READ_BLOCK_MS, COUNT: 20 });
        if (!response) continue;

        for (const stream of response) {
            for (const message of stream.messages) {
                cursor = message.id;
                if (message.message?.taskId !== taskId) continue;
                return decodeResult(taskId, message.message);
            }
        }
    }

    // The window expired — the work is NOT lost; the plane still finishes it and
    // the result stays on ai:results. Callers treat `pending` as "try later".
    return { taskId, status: "pending", pending: true, sinceId };
}

/**
 * Look for the result of an earlier task on ai:results, without submitting
 * anything. Scans forward from `sinceId` (inclusive; the taskId match makes the
 * boundary entry harmless) up to a bounded number of entries.
 *
 * @param {{ taskId: string, sinceId?: string, maxEntries?: number }} args
 * @returns {Promise<object>} the decoded result, or { taskId, status: "pending", pending: true }
 *   when it has not arrived (or was trimmed off the stream).
 */
export async function collectAiResult({ taskId, sinceId = "-", maxEntries = COLLECT_MAX_ENTRIES } = {}) {
    if (!taskId) throw planeError("taskId is required", "HR-AI-PLANE-BAD-REQUEST");
    const client = await getClient();

    let start = sinceId || "-";
    let scanned = 0;
    while (scanned < maxEntries) {
        const entries = await client.xRange(RESULTS_STREAM, start, "+", { COUNT: COLLECT_PAGE });
        if (!entries?.length) break;
        for (const entry of entries) {
            if (entry.message?.taskId === taskId) return decodeResult(taskId, entry.message);
        }
        scanned += entries.length;
        if (entries.length < COLLECT_PAGE) break;
        // Next page starts after the last entry read (exclusive range, Redis 6.2+).
        start = `(${entries[entries.length - 1].id}`;
    }
    return { taskId, status: "pending", pending: true };
}
