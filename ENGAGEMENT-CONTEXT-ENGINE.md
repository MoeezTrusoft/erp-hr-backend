# Engagement Context Engine (ECE)

Communication-driven relationship context for a publishing business: every email,
SMS, web chat, call transcript, voicemail, meeting and staff note about a visitor,
lead, client, author or publishing user is folded into one maintained, versioned
context that Claude uses to draft emails, SMS, quotations, proposals, NDAs,
contracts, editorial assessments, meeting summaries and project briefs, and to
create or update projects in the PM module.

Backend: `erp-hr-backend/src/services/engagement/**` (MCP tools `hr_engagement_*`,
REST `/api/hr/engagement/*`). Frontend: `erp-trusoft-frontend/apps/erp-web/src/domains/engagement/**`
(route `/engagement`, feature flag `VITE_FEATURE_ENGAGEMENT_CONTEXT`).

---

## 1. Why this design

| Decision | Reason |
|---|---|
| **Build on Unified Communication Threads**, do not replace them | The Communication service already owns parties, identity links, cross-channel timelines and source subscriptions (`communication_thread_*`). ECE consumes those timelines (`hr_engagement_thread_import`) and the comms fabric events; it never becomes a second mailbox. |
| **One party anchor** (`EngagementParty`) with identity links to Sales lead/customer, comms thread party, mailbox, phone | Messages arrive from any channel with only an address; resolving them to one counterparty is what makes "the complete context" possible. |
| **Facts with provenance + a merged profile**, not a raw transcript dump | Staff can audit and correct every claim (`sourceEventId`, supersede/retract), and the profile stays small enough to sit in every prompt. |
| **Versioned profile, incremental refresh** | Each refresh folds only unprocessed events (`extractedAt IS NULL`) into the profile with ONE structured LLM call; version increments; events are stamped. Cost is proportional to new communication, not history size. |
| **Drafts are reviewed, never auto-sent** | Documents move DRAFT → REVIEWED → APPROVED → SENT; SENT records the delivery reference from the channel tool the user used (mail/SMS/chat). The sent text becomes an OUTBOUND event, closing the loop. |
| **PM integration both ways** | A proposal (project payload + brief + tasks) is stored; the frontend applies it through the PM tools it already holds (`project_project_create`, `project_brief_save`) and confirms the id, or the backend syncs through PM's MCP with the service identity. |
| **Hosted in erp-hr-backend** | It is the only service in scope; the module is self-contained (`services/engagement`, own tables, own queue) so it can be lifted into a dedicated service later. Tool names must carry the `hr_` prefix because the gateway federates by prefix. |
| **Claude via the official SDK, structured outputs, prompt caching, server-side fallbacks** | `claude-opus-5-5` by default; frozen system prompts are cached; every call is recorded (`EngagementLlmRun`) with tokens, cache hits, latency and stop reason. |

---

## 2. Architecture

```
            ┌──────────────── Communication service ────────────────┐
            │ mail · SMS · webchat · calls/transcripts · voicemail  │
            │ Unified Threads: party, identity links, timeline      │
            └──────┬────────────────────────────┬───────────────────┘
   comms.* fabric  │ (ids only, Redis stream)    │ communication_thread_timeline
                   ▼                             ▼  (frontend, user-authorised)
┌────────────── erp-hr-backend · services/engagement ─────────────────────────┐
│ inbox.service     ingest.service      party.service     receipts (X-08)     │
│ (fabric intake,   (normalise, dedupe, (resolve/merge,   requestKey replay)  │
│  source fetch)     mark dirty)         identity links)                      │
│                         │                                                   │
│ jobs/engagement.queue ──┼── profile-refresh (debounced per party)           │
│ (BullMQ, DLQ, sweep,    ▼                                                   │
│  inbox-drain, bridge)  profile.service ──▶ claude.client (Opus 5.5)        │
│                        facts + profile + summary + next best actions        │
│                         │                                                   │
│   generation.service ◀──┤──▶ project-sync.service ──▶ pm-mcp.client ──▶ PM │
│   (12 document kinds)   │    (proposal, brief, tasks)                       │
│   ask.service (Q&A with citations)                                          │
│                         ▼                                                   │
│ outbox (engagement.*.v1) ──▶ hr:events stream ──▶ gateway notifications     │
└─────────────────────────────────────────────────────────────────────────────┘
                   ▲ MCP tools hr_engagement_* (25) · REST /api/hr/engagement
┌──────────────────┴──────────────────────────────────────────────────────────┐
│ erp-trusoft-frontend · domains/engagement · Context Workspace               │
│ parties · overview · timeline · facts · documents · projects · ask          │
│ bridge registry: project_project_create/update, project_brief_save,         │
│                  communication_thread_timeline                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Request path
1. Gateway verifies the user, forwards the tool call with a service JWT (tenant + scope) to HR `/mcp`.
2. `engagementTools.js` → `handlers.js`: **permission first** (`hr:engagement` VIEW/CREATE/EDIT via `assertPermission`), then zod validation, then a `tenantTransaction` (FORCE RLS GUC set).
3. Services write rows + outbox events in the same transaction; LLM calls are recorded as `EngagementLlmRun` in the same transaction as the artefact they produced.

---

## 3. Data model (Prisma, migration `20261021090000_engagement_context_engine`)

All tables: uuid ids, `tenantId @db.Uuid`, FORCE ROW LEVEL SECURITY with the HR tenant GUC policy, registered in `rlsTenant.js` RLS_MODELS, string enums guarded by SQL CHECK constraints.

| Model | Purpose | Key fields |
|---|---|---|
| `EngagementParty` | counterparty anchor | kind PERSON/ORGANIZATION · role VISITOR/LEAD/CLIENT/PUBLISHING_USER/AUTHOR/PARTNER · stage NEW…WON/ACTIVE/DORMANT/LOST/MERGED · emails[] phones[] (normalised) · identities[{system, externalId}] · tags · ownerUserId · mergedIntoId · version |
| `EngagementEvent` | one normalised communication | channel EMAIL/SMS/WEBCHAT/CHAT/CALL/TRANSCRIPT/VOICEMAIL/MEETING/NOTE/FORM/DOCUMENT/SYSTEM · direction · sourceSystem/sourceId/sourceThreadId · `dedupeKey` unique per tenant · occurredAt · subject/body/bodyHash · participants · attachments (DAM/mail refs) · metadata · `extractedAt` (null = not yet folded into the profile) |
| `EngagementProfile` | the living context (one per party) | version · summary · structured (schema §5) · model · lastEventAt · lastRefreshedAt · eventsAtRefresh · refreshStatus IDLE/QUEUED/RUNNING/FAILED |
| `EngagementFact` | atomic, traceable claims | kind (IDENTITY, CONTACT_RULE, PREFERENCE, REQUIREMENT, PROJECT_DETAIL, COMMITMENT, DECISION, OBJECTION, TIMELINE, BUDGET, RISK, SENTIMENT, OTHER) · key (stable snake_case) · value · confidence · status ACTIVE/SUPERSEDED/RETRACTED · sourceEventId · supersededById · profileVersion |
| `EngagementDocument` | generated content | kind (12) · status DRAFT/REVIEWED/APPROVED/SENT/ARCHIVED · title/body/format · structured (quote lines, action items…) · instructions · profileVersion · sourceEventIds · llmRunId · version · approvedBy/approvedAt · sentAt/deliveryRef |
| `EngagementProjectLink` | PM proposal/sync record | requestKey unique · pmProjectId · status PROPOSED/SYNCING/CREATED/UPDATED/FAILED/DISMISSED · proposal (project, brief, tasks, pmPayload) · brief (BriefContent) · lastSyncedAt/lastError |
| `EngagementLlmRun` | audit of every model call (append-only) | purpose EXTRACT/GENERATE/PROJECT_PROPOSAL/ASK · model · input/output/cacheRead/cacheWrite tokens · latencyMs · stopReason · status · errorCode · requestHash |
| `EngagementInboxEvent` | fabric envelopes awaiting processing | eventId unique · source · payload · status PENDING/PROCESSED/SKIPPED/FAILED · attempts · nextAttemptAt |
| `EngagementCommandReceipt` | idempotent command replay (append-only) | requestKey unique · toolName · digest · result |

---

## 4. Flows

### 4.1 Intake
* **Staff / forms**: `hr_engagement_event_ingest` (channel, body, participants, attachments, `resolve` by email/phone/identity or `partyId`, optional `requestKey`). Unknown senders become a VISITOR party.
* **Communication threads**: the workspace calls `communication_thread_timeline` for the party's thread(s) with the user's own authorisation and pushes the items into `hr_engagement_thread_import` (calls with transcripts become TRANSCRIPT events; dispositions and durations are kept as metadata). Deduplicated on `COMMUNICATION_THREAD:<channel>:<sourceId>`.
* **Fabric**: `startSourceBridge` consumes `HR_ENGAGEMENT_SOURCE_STREAMS` (e.g. `comms:events`) with a consumer group; accepted names: `comms.mail.received.v1`, `comms.mail.sent.v1`, `comms.sms.sent.v1`, `comms.call.transcript_published.v1`, `comms.voicemail.transcribed.v1`. Rows land in `EngagementInboxEvent`; `inbox-drain` fetches the body through the Communication MCP (`HR_ENGAGEMENT_SOURCE_FETCH=communication`, `COMMUNICATION_SERVICE_URL`) or marks `SKIPPED/NO_SOURCE_FETCH` until the thread import supplies it.
* Every ingest marks the profile `QUEUED` and emits `engagement.event.ingested.v1`.

### 4.2 Context refresh
* `profile-refresh` job per party, debounced (`HR_ENGAGEMENT_REFRESH_DEBOUNCE_MS`, default 45 s) by a stable BullMQ jobId; `refresh-sweep` queues every QUEUED profile every 2 minutes; staff can force it with `hr_engagement_profile_refresh`.
* Context bundle = party + current profile + active facts + token-budgeted window of unprocessed events (newest first until `tokenBudget`, then chronological and indexed `[#i]`), C4-redacted (cards, IBAN, CNIC, secrets).
* One structured call (`ExtractionOutputSchema`): facts (with `supersedesKey`), merged profile, 4–8 sentence summary, next best actions. New facts supersede active facts with the same key; events are stamped `extractedAt`; version +1; `engagement.profile.refreshed.v1` emitted.

### 4.3 Generation
`hr_engagement_document_generate` builds the same context bundle plus the kind template (§6), staff instructions, tone, language, optional `replyToEventId`, and returns a DRAFT with `missingInformation`, `assumptions`, `suggestedSubject`, structured block and the event ids it relied on. Staff edit (`document_update`, optimistic `expectedVersion`), approve and mark SENT with the channel delivery reference; SENT appends an OUTBOUND event and re-queues the profile.

### 4.4 PM projects
`hr_engagement_project_propose` → `ProjectProposalSchema` (project, brief with acceptance criteria, task breakdown with effort/confidence, rationale) stored on an `EngagementProjectLink` with a ready `pmPayload` that matches PM's `createProjectSchema` (`configuration.planningMode=ai`, `aiPlanningBrief`, `deliverables`, `constraints`, `targetTimeline`, tags) and a `brief` matching `BriefContent` for `project_brief_save`.
* Frontend path: "Create in PM" calls `project_project_create` (and `project_brief_save`), then `hr_engagement_project_confirm` records the id.
* Service path: `hr_engagement_project_sync` calls PM's MCP (`pm-mcp.client.js`, service JWT, idempotency key) for create or update (`expectedProjectVersion` required for update) and records CREATED/UPDATED/FAILED.
* Re-proposing with `pmProjectId` produces an UPDATE proposal from the latest context (scope changes, new deadlines).

### 4.5 Ask
`hr_engagement_context_ask` answers staff questions with a confidence level, citations (event ids/channels/dates) and follow-up questions.

### 4.6 Merge
`hr_engagement_party_merge` moves events, facts, documents, links and runs to the survivor, unions contact points, tombstones the source (stage MERGED, mergedIntoId) and queues a refresh so one coherent profile is rebuilt.

---

## 5. Context profile schema (what Claude maintains)

`identity` (names, organisation, role, location, timezone, language, contact preferences) · `publishing` (author type, genres, titles[{title, genre, manuscriptStage, wordCount, formats, status}], services discussed/purchased, target audience, goals, platforms) · `commercial` (budget band/notes/currency, quoted amounts, payment terms, purchasing authority, decision makers, NDA/contract status) · `timeline` (target publication date, hard deadlines, agreed milestones) · `relationship` (stage, sentiment, intent, communication style, responsiveness, trust signals, friction points) · `commitments` (ours/theirs with due dates and status) · `decisions` · `objections` · `openQuestions` · `riskFlags` · `doNotMention` · `nextBestActions`.

The `publishing` and `commercial` blocks mirror Sales' qualification record (title, genre, manuscriptStage, wordCount, services, formats, budget, targetPublicationDate, purchasingAuthority, audience) so the context can pre-fill `sales_qualification_save`.

---

## 6. Prompting and model usage

* **Model**: `ENGAGEMENT_LLM_MODEL` (default `claude-opus-5-5`); effort medium for extraction/ask, high for generation and project proposals; adaptive thinking (the model default); `max_tokens` 16 000 (configurable).
* **Caching**: `SYSTEM_CORE` + task-specific instructions are frozen strings with a `cache_control` breakpoint; all volatile material (profile JSON, facts, events, instructions, today's date) is in the user message. Cache reads are recorded per run so the hit rate is observable.
* **Structured outputs**: `output_config.format = zodOutputFormat(schema)`; the text is parsed and validated again with zod; schema mismatch → `HR-4705`.
* **Safety**: `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) rescues classifier declines; a final `stop_reason: refusal` → `HR-4704`; `max_tokens` → `HR-4705`; missing/rejected key → `HR-4703` (503); transport → `HR-4709` (503).
* **Grounding rules** are in `SYSTEM_CORE`: no invented names, prices, dates or commitments; conflicts resolved to the most recent statement and recorded; placeholders `[CONFIRM: …]` for missing facts; `[REDACTED:…]` tokens preserved.
* **Templates** (`DOCUMENT_TEMPLATES`): EMAIL, SMS (≤320 chars), CHAT_REPLY, QUOTATION (lines/subtotal/total/validity), PROPOSAL, NDA (draft for legal review), CONTRACT (draft for legal review), EDITORIAL_ASSESSMENT (only from manuscript material in the record; otherwise says what to request), MEETING_SUMMARY, PROJECT_BRIEF, HANDOVER_BRIEF, CUSTOM.

---

## 7. Tool contract (gateway-federated, `hr_` prefix)

| Family | Tools | Entitlement (`hr:engagement`) |
|---|---|---|
| Parties | party_list, party_get, party_resolve · party_create · party_update, identity_link, party_merge | VIEW · CREATE · EDIT |
| Intake | event_list · event_ingest, thread_import | VIEW · CREATE |
| Profile | profile_get, fact_list · profile_refresh, fact_update | VIEW · EDIT |
| Documents | document_list, document_get · document_generate · document_update, document_transition | VIEW · CREATE · EDIT |
| Projects | project_link_list · project_propose · project_confirm, project_sync | VIEW · CREATE · EDIT |
| Q&A | context_ask, catalog_get | VIEW |

Frontend permission tokens: `hr.engagement.read`, `hr.engagement.create`, `hr.engagement.update` (X-06 blob key `hr:engagement` with VIEW/CREATE/EDIT). **These keys must be added to the RBAC catalog/seed before the tools return anything but 403** (lesson in CLAUDE.md).

Events emitted (ids only): `engagement.event.ingested.v1`, `engagement.profile.refreshed.v1`, `engagement.document.generated.v1`, `engagement.document.transitioned.v1`, `engagement.project.proposed.v1`, `engagement.project.synced.v1`.

Error codes: HR-4700 bad request · 4701 party not found · 4702 document not found · 4703 LLM not configured · 4704 model refused · 4705 output truncated/invalid · 4706 requestKey conflict · 4707 version conflict (412) · 4708 link not found · 4709 LLM unavailable · 4710 invalid state transition.

---

## 8. Configuration and operations

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required for any LLM-backed tool (503 HR-4703 otherwise) |
| `ENGAGEMENT_LLM_MODEL` | `claude-opus-5-5` | model id |
| `ENGAGEMENT_LLM_TIMEOUT_MS` / `ENGAGEMENT_LLM_MAX_TOKENS` / `ENGAGEMENT_LLM_TX_TIMEOUT_MS` | 120000 / 16000 / 300000 | client timeout, output ceiling, DB transaction ceiling for LLM-backed handlers |
| `HR_ENGAGEMENT_JOBS_ENABLED` | true | BullMQ queue `hr-engagement` (+ `hr-engagement-dead`) |
| `HR_ENGAGEMENT_REFRESH_DEBOUNCE_MS` / `HR_ENGAGEMENT_SWEEP_MS` / `HR_ENGAGEMENT_INBOX_MS` / `HR_ENGAGEMENT_CONCURRENCY` | 45000 / 120000 / 30000 / 2 | job cadence |
| `HR_ENGAGEMENT_SOURCE_STREAMS` | (empty = bridge off) | comma list of Redis streams carrying comms envelopes, e.g. `comms:events` |
| `HR_ENGAGEMENT_CONSUMER_GROUP` | `hr-engagement-v1` | stream consumer group |
| `HR_ENGAGEMENT_SOURCE_FETCH` + `COMMUNICATION_SERVICE_URL` (+ `COMMUNICATION_MCP_PATH`, `COMMUNICATION_SERVICE_TIMEOUT`) | off | fetch bodies for fabric events through the Communication MCP |
| `PM_SERVICE_URL` + `PM_MCP_PATH` + `PM_SERVICE_TIMEOUT` | `http://localhost:3003` + `/mcp` | server-side project sync |

Rollout: `npx prisma migrate deploy` (additive), deploy HR, seed the three permission keys in RBAC, set the API key, enable the feature flag on the frontend (`VITE_FEATURE_ENGAGEMENT_CONTEXT=true`). Dead letters: BullMQ queue `hr-engagement-dead` and Redis stream `hr:engagement:dead-letter`. Observability: `EngagementLlmRun` (tokens, cache hit, latency per purpose), pino logs with correlation ids, outbox heartbeat at `/compliance`.

Cost control levers: debounce window, `eventLimit`/`tokenBudget` on refresh, effort per purpose, cache hit rate (watch `cacheReadTokens`), and `claude-sonnet-5-5` for extraction/ask if measured quality allows.

---

## 9. Further uses for the publishing business

Once every lead, author and client carries a maintained, versioned context profile, the same engine serves other publishing workflows with no new data plumbing:

| # | Use | Already provided | Extra work |
|---|-----|------------------|-----------|
| 1 | **Sales co-pilot inside the CSR chat room** | `CHAT_REPLY` kind, profile intent/sentiment/summary | Bind the static AI slots in Sales `RightPanel` (detected intent, sentiment, summary, copilot suggestion) to `hr_engagement_profile_get` + `document_generate(kind=CHAT_REPLY)` |
| 2 | **Lead qualification pre-fill** | `publishing` + `commercial` profile blocks mirror Sales qualification | One adapter from profile → `sales_qualification_save`; lead scoring input (`sales_lead_score`) from sentiment, intent, budget band |
| 3 | **Manuscript intake triage** | titles[], manuscriptStage, wordCount, genres, risk flags | A `manuscript_triage` kind scoring readiness and routing to the right editor pool; attach the manuscript via DAM asset id |
| 4 | **Editorial assessment first drafts** | `EDITORIAL_ASSESSMENT` kind | Feed sample chapters (DAM attachment → event body) so the memo is grounded; editors keep final judgement |
| 5 | **Churn / silence / sentiment alerts** | sentiment, riskFlags, lastEventAt per refresh | Nightly job emitting `engagement.profile.risk.v1` → Sales ticket (`sales_ticket_create`) when sentiment drops or a client is silent past SLA |
| 6 | **Handover and shift briefs** | `HANDOVER_BRIEF` kind | Wire to `communication_thread_handover` reason text and CSR shift changes |
| 7 | **Package recommendation and quotation** | servicesDiscussed, budget, timeline | Rank Sales packages (`sales_package_list`) against the profile; `QUOTATION` kind outputs lines → `sales_quote_create` |
| 8 | **Launch marketing copy** | book metadata, audience, author bio, tone | Kinds for back-cover copy, retailer description, press release, launch email sequence (Content module briefs) |
| 9 | **Author voice profile for ghostwriting** | author's own emails/chats | A `voice_profile` fact family (vocabulary, cadence, register) and a style guard in ghostwriting drafts |
| 10 | **Contract / royalty Q&A for the author portal** | contract terms in facts, `context_ask` | Read-only "explain my agreement" surface grounded in the signed agreement (Finance royalty contracts) |
| 11 | **Objection and pricing intelligence** | OBJECTION / DECISION facts across parties | Anonymised aggregate report for sales training and pricing |
| 12 | **Quality scoring of staff replies** | outbound events on the timeline | Rubric-based LLM scoring of tone, accuracy vs profile, SLA adherence; coaching dashboard |
| 13 | **Project kickoff automation** | project proposals with tasks and milestones | Milestone templates per service (editing, cover, formatting, distribution), `project_task_bulk_create`, capacity-based assignment |
| 14 | **Compliance** | every generation stores the exact source events and LLM run | DSAR export per party (facts + sources), right-to-be-forgotten purge job, retention policy on events |
| 15 | **Forecasting** | opportunity amount, stage and intent facts | Advisory close-probability input to `sales_forecast_generate`, labelled as model-estimated |

---

## 10. What is not done / next steps

* RBAC seed for `hr:engagement` (VIEW/CREATE/EDIT) lives in the RBAC repo; gateway capability map must federate `hr_engagement_*`.
* The Communication fabric stream name and mail/SMS/transcript `get` tool names are configured, not verified against the running Communication service; `thread_import` is the proven path today.
* Visual and journey baselines could not be run in this environment; the new sidebar group is feature-flagged off by default so existing pixels are unchanged.
* Candidates for a follow-up: embeddings for cross-party search, per-tenant prompt overrides (house style, services catalogue), attachment text extraction (DOCX/PDF manuscripts) into events, and a scheduled "daily digest" document kind.
