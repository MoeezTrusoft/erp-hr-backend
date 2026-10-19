// src/services/engagement/claude.client.js — the ONE Anthropic client of the
// HR service. Every engagement LLM call goes through runStructured() so that:
//   * the model, effort and token ceilings are configured in one place,
//   * the stable system prompt is cached (cache_control on the system block),
//   * refusals (stop_reason "refusal") and truncation are mapped to HR-47xx,
//   * server-side fallbacks ("default") rescue classifier declines,
//   * every call is recorded as an EngagementLlmRun (tokens, latency, status).
//
// Env:
//   ANTHROPIC_API_KEY             required at runtime (503 HR-4703 if absent)
//   ENGAGEMENT_LLM_MODEL          default claude-opus-5-5
//   ENGAGEMENT_LLM_TIMEOUT_MS     default 120000
//   ENGAGEMENT_LLM_MAX_TOKENS     default 16000
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { fail, hash, log } from "./base.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const EFFORT_BY_PURPOSE = Object.freeze({
  EXTRACT: "medium",
  GENERATE: "high",
  PROJECT_PROPOSAL: "high",
  ASK: "medium",
});

let clientFactory = null;
let cachedClient = null;

/** Test seam: inject a fake client factory (returns an object with beta.messages.create). */
export function setAnthropicClientFactory(factory) {
  clientFactory = factory;
  cachedClient = null;
}

async function getClient() {
  if (cachedClient) return cachedClient;
  if (clientFactory) {
    cachedClient = await clientFactory();
    return cachedClient;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("HR-4703", "The engagement context engine is not configured (ANTHROPIC_API_KEY missing)", 503);
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  cachedClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number.parseInt(process.env.ENGAGEMENT_LLM_TIMEOUT_MS || "120000", 10),
    maxRetries: 2,
  });
  return cachedClient;
}

export const configuredModel = () => process.env.ENGAGEMENT_LLM_MODEL || DEFAULT_MODEL;

const textOf = (message) =>
  (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");

/**
 * Run one structured-output request.
 * @param {object} args
 * @param {('EXTRACT'|'GENERATE'|'PROJECT_PROPOSAL'|'ASK')} args.purpose
 * @param {string} args.system        frozen system prompt (cached prefix)
 * @param {Array}  args.messages      Anthropic MessageParam[] (volatile content)
 * @param {import('zod').ZodType} args.schema  output schema
 * @param {string} [args.effort]
 * @param {number} [args.maxTokens]
 * @returns {Promise<{ output: object, run: object }>} parsed output + run metrics
 */
export async function runStructured({ purpose, system, messages, schema, effort, maxTokens }) {
  const client = await getClient();
  const model = configuredModel();
  const startedAt = Date.now();
  const request = {
    model,
    max_tokens: maxTokens ?? Number.parseInt(process.env.ENGAGEMENT_LLM_MAX_TOKENS || "16000", 10),
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
    output_config: {
      effort: effort || EFFORT_BY_PURPOSE[purpose] || "medium",
      format: zodOutputFormat(schema),
    },
  };
  const requestHash = hash({ model, system: hash(system), messages }).slice(0, 32);

  let response;
  try {
    response = await client.beta.messages.create(request);
  } catch (err) {
    const status = err?.status;
    log().warn({ purpose, model, status, err: { message: err?.message, name: err?.name } }, "engagement llm request failed");
    if (status === 401 || status === 403) fail("HR-4703", "The engagement context engine credentials were rejected", 503);
    if (status === 400) fail("HR-4700", "The engagement context request was rejected by the model API", 400);
    fail("HR-4709", "The engagement context engine is temporarily unavailable", 503);
  }

  const usage = response?.usage ?? {};
  const run = {
    purpose,
    model: response?.model || model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
    stopReason: response?.stop_reason ?? null,
    status: "SUCCEEDED",
    errorCode: null,
    requestHash,
  };

  if (response?.stop_reason === "refusal") {
    run.status = "REFUSED";
    run.errorCode = "HR-4704";
    return { output: null, run, error: Object.assign(new Error("The model declined this request"), { status: 422, code: "HR-4704" }) };
  }
  if (response?.stop_reason === "max_tokens") {
    run.status = "FAILED";
    run.errorCode = "HR-4705";
    return { output: null, run, error: Object.assign(new Error("The model output was truncated; narrow the request"), { status: 422, code: "HR-4705" }) };
  }

  let output;
  try {
    output = schema.parse(JSON.parse(textOf(response)));
  } catch (err) {
    run.status = "FAILED";
    run.errorCode = "HR-4705";
    log().warn({ purpose, model, err: { message: err?.message } }, "engagement llm output did not match schema");
    return { output: null, run, error: Object.assign(new Error("The model output did not match the expected schema"), { status: 422, code: "HR-4705" }) };
  }
  return { output, run, error: null };
}

/** Persist a run record (best effort; never fails the caller). */
export async function recordRun(tx, { tenantId, partyId }, run) {
  try {
    const row = await tx.engagementLlmRun.create({
      data: { tenantId, partyId: partyId ?? null, ...run },
    });
    return row?.id ?? null;
  } catch (err) {
    log().warn({ err: { message: err?.message } }, "engagement llm run record failed");
    return null;
  }
}
