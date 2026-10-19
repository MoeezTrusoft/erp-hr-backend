// src/services/engagement/ask.service.js — "ask the relationship": grounded
// Q&A over one party's context with citations to source events.
import { z } from "zod";

import { recordRun, runStructured } from "./claude.client.js";
import { buildContextBundle, renderContext } from "./context-builder.js";
import { getPartyOrFail } from "./party.service.js";
import { AskOutputSchema, SYSTEM_ASK } from "./prompts.js";

export const AskInputSchema = z.object({
  partyId: z.string().uuid(),
  question: z.string().trim().min(3).max(2000),
  eventLimit: z.number().int().min(1).max(200).optional(),
});

export async function askContext(tx, env, rawInput) {
  const input = AskInputSchema.parse(rawInput);
  const party = await getPartyOrFail(tx, env, input.partyId);
  const bundle = await buildContextBundle(tx, env, party, { eventLimit: input.eventLimit });
  const messages = [{ role: "user", content: `${renderContext(bundle)}\n\nQUESTION: ${input.question}` }];
  const { output, run, error } = await runStructured({ purpose: "ASK", system: SYSTEM_ASK, messages, schema: AskOutputSchema, maxTokens: 4000 });
  const runId = await recordRun(tx, { tenantId: env.tenantId, partyId: party.id }, run);
  if (error) throw error;
  return {
    partyId: party.id,
    answer: output.answer,
    confidence: output.confidence,
    citations: output.citedEventIndexes.map((i) => bundle.events[i]).filter(Boolean).map((e) => ({ eventId: e.id, channel: e.channel, occurredAt: e.occurredAt, subject: e.subject ?? null })),
    followUpQuestions: output.followUpQuestions,
    llmRunId: runId,
  };
}
