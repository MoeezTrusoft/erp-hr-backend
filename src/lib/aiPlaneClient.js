// src/lib/aiPlaneClient.js — [HR-AI-PLANE-01]
//
// HR's side of the ai:tasks contract (§7.1 / ARCH-04 / WBS C.7). The AI plane
// (erp-ai-plane) is the only service in the fleet permitted to hold an LLM SDK
// or provider credentials; HR XADDs a task keyed by promptKey and reads the
// result back off ai:results with a bounded wait.
//
//   ai:tasks    { taskId, tenantId, type, promptKey, input, correlationId }
//   ai:results  { taskId, tenantId, status, output, error?, tokensUsed }
//
// WHY THIS EXISTS: §7.1 says "no vendor hard-coded in HR — all Recruitment AI
// calls go through the dedicated AI service plane". resumeParsing.service.js
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
 *            tokensUsed?:number, pending?:boolean}}
 *   `pending: true` means the wait window expired, NOT that the task failed —
 *   the result will still land on ai:results to be collected later.
 */
export async function runAiTask({ promptKey, type, tenantId, input, correlationId, waitMs } = {}) {
    if (!promptKey) throw planeError("promptKey is required", "HR-AI-PLANE-BAD-REQUEST");

    const client = await getClient();

    const taskId = crypto.randomUUID();

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

    await client.xAdd(TASKS_STREAM, "*", {
        taskId,
        tenantId: String(tenantId ?? ""),
        type: String(type ?? promptKey),
        promptKey,
        // The plane redacts PII from `input` before building the prompt (§7.1a),
        // so it travels as one JSON field rather than spread across fields.
        input: JSON.stringify(input ?? {}),
        correlationId: String(correlationId ?? taskId),
    });

    logger.info({ taskId, promptKey, tenantId }, "hr ai task submitted");

    const deadline = Date.now() + (waitMs ?? DEFAULT_WAIT_MS);
    while (Date.now() < deadline) {
        const response = await client.xRead({ key: RESULTS_STREAM, id: cursor }, { BLOCK: READ_BLOCK_MS, COUNT: 20 });
        if (!response) continue;

        for (const stream of response) {
            for (const message of stream.messages) {
                cursor = message.id;
                if (message.message?.taskId !== taskId) continue;

                const raw = message.message;
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
        }
    }

    // The window expired — the work is NOT lost; the plane still finishes it and
    // the result stays on ai:results. Callers treat `pending` as "try later".
    return { taskId, status: "pending", pending: true };
}
