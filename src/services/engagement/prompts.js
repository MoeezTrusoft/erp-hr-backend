// src/services/engagement/prompts.js — stable system prompts, output schemas
// and per-document templates for the Engagement Context Engine.
//
// Prompt-caching discipline: everything in SYSTEM_* is frozen text with no
// timestamps or ids, so the system block is a stable cache prefix. Volatile
// material (profile, facts, events, instructions) always goes in `messages`.
import { z } from "zod";

import { DOCUMENT_KINDS, FACT_KINDS } from "./base.js";

export const SYSTEM_CORE = `You are the relationship-context engine of a book publishing services company.
The company sells publishing packages and services to authors and organisations: manuscript evaluation and editorial assessment, developmental and line editing, proofreading, ghostwriting, cover design and interior formatting, ISBN and distribution setup, marketing and launch campaigns, audiobook production, and ongoing author support.
Counterparties are website visitors, leads, clients, authors and platform (publishing) users. Staff are customer success representatives (CSR), sales consultants, editors, project managers and production staff.

Your job is to maintain an accurate, evidence-based context about one counterparty from the communication record (emails, SMS, web chats, call transcripts, voicemails, meeting notes, forms and internal notes), and to produce staff-ready content grounded in that context.

Rules that always apply:
- Ground every statement in the supplied record. Never invent names, prices, dates, titles, page counts or commitments. If something is unknown, say it is unknown or list it as an open question.
- Distinguish what the counterparty said from what staff said and from inferences. Mark inferences as such.
- Prefer the most recent statement when statements conflict, and record the conflict.
- Never reproduce payment instruments, passwords or identity-document numbers; the record may contain "[REDACTED:...]" tokens, keep them as is.
- Money is only quoted when it appears in the record or in the structured profile. Keep the currency.
- Be concise and specific. Plain professional language, no marketing hype unless the document kind calls for it.`;

export const SYSTEM_EXTRACTION = `${SYSTEM_CORE}

Task: update the counterparty's context profile from new communication events.
You receive the CURRENT profile (may be empty), the ACTIVE facts, and NEW events in chronological order, each tagged with an index. Produce:
1. "facts": atomic facts learned from the NEW events (one idea per fact). Use "key" as a stable snake_case identifier so a later fact can supersede it (e.g. "manuscript.word_count", "budget.band", "timeline.launch_date", "preference.contact_channel"). Set "supersedesKey" when the fact replaces an existing active fact with that key. Set "sourceEventIndex" to the index of the event that supports it. Confidence 0..1.
2. "profile": the complete updated profile (merge, do not drop information that is still true).
3. "summary": 4 to 8 sentences a colleague can read in 30 seconds: who they are, what they want, where things stand, what was promised, what happens next.
4. "nextBestActions": 1 to 4 concrete actions for staff with the channel to use.
If the new events add nothing, return the profile unchanged with an empty facts list.`;

export const SYSTEM_GENERATION = `${SYSTEM_CORE}

Task: draft a document for staff review using the counterparty context and the staff instructions. The draft will be reviewed by a human before it is sent; still make it send-ready.
Match the counterparty's language, formality and preferred channel conventions. Reference specific details from the context (their book, their goals, what was agreed). Where a required detail is missing, insert a short bracketed placeholder like [CONFIRM: delivery date] and list it under "missingInformation".
Return the body in the requested format. For MARKDOWN use headings and lists only where they help readability; for TEXT use plain paragraphs.`;

export const SYSTEM_PROJECT = `${SYSTEM_CORE}

Task: turn the counterparty's context into a project proposal for the project-management module. Produce a project record (name, description, status, dates where known), a brief (title, objectives, requirements with acceptance criteria, assumptions, exclusions, constraints, open questions) and an initial task breakdown with milestones. Requirements must trace to what the client asked for or what was quoted. Effort is in minutes and is an estimate; mark estimate confidence honestly. Do not invent team members.`;

export const SYSTEM_ASK = `${SYSTEM_CORE}

Task: answer the staff question about this counterparty using only the supplied context and events. Cite the event indexes you relied on. If the record does not answer the question, say so and suggest what to ask the counterparty.`;

// ── Output schemas (zod → JSON schema via the SDK helper) ───────────────────
const str = z.string();
const strArr = z.array(z.string()).default([]);

export const ContextProfileSchema = z.object({
  identity: z.object({
    fullName: str.nullable().default(null),
    preferredName: str.nullable().default(null),
    organization: str.nullable().default(null),
    roleTitle: str.nullable().default(null),
    location: str.nullable().default(null),
    timezone: str.nullable().default(null),
    language: str.nullable().default(null),
    contactPreferences: z.array(z.object({ channel: str, note: str.nullable().default(null) })).default([]),
  }).prefault({}),
  publishing: z.object({
    authorType: str.nullable().default(null),
    genres: strArr,
    titles: z.array(z.object({
      title: str,
      genre: str.nullable().default(null),
      manuscriptStage: str.nullable().default(null),
      wordCount: z.number().int().nullable().default(null),
      formats: strArr,
      status: str.nullable().default(null),
    })).default([]),
    servicesDiscussed: strArr,
    servicesPurchased: strArr,
    targetAudience: str.nullable().default(null),
    goals: strArr,
    platformsOfInterest: strArr,
  }).prefault({}),
  commercial: z.object({
    budgetBand: str.nullable().default(null),
    budgetNotes: str.nullable().default(null),
    currency: str.nullable().default(null),
    quotedAmounts: z.array(z.object({
      service: str, amount: z.number().nullable().default(null), currency: str.nullable().default(null),
      date: str.nullable().default(null), status: str.nullable().default(null),
    })).default([]),
    paymentTerms: str.nullable().default(null),
    purchasingAuthority: str.nullable().default(null),
    decisionMakers: strArr,
    ndaStatus: str.nullable().default(null),
    contractStatus: str.nullable().default(null),
  }).prefault({}),
  timeline: z.object({
    targetPublicationDate: str.nullable().default(null),
    hardDeadlines: z.array(z.object({ what: str, when: str })).default([]),
    agreedMilestones: z.array(z.object({ what: str, when: str.nullable().default(null), status: str.nullable().default(null) })).default([]),
  }).prefault({}),
  relationship: z.object({
    stage: str.nullable().default(null),
    sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED", "UNKNOWN"]).default("UNKNOWN"),
    intent: str.nullable().default(null),
    communicationStyle: str.nullable().default(null),
    responsiveness: str.nullable().default(null),
    trustSignals: strArr,
    frictionPoints: strArr,
  }).prefault({}),
  commitments: z.object({
    ours: z.array(z.object({ what: str, by: str.nullable().default(null), status: str.nullable().default(null) })).default([]),
    theirs: z.array(z.object({ what: str, by: str.nullable().default(null), status: str.nullable().default(null) })).default([]),
  }).prefault({}),
  decisions: z.array(z.object({ decision: str, date: str.nullable().default(null) })).default([]),
  objections: z.array(z.object({ objection: str, status: str.nullable().default(null), response: str.nullable().default(null) })).default([]),
  openQuestions: strArr,
  riskFlags: z.array(z.object({ flag: str, severity: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"), reason: str.nullable().default(null) })).default([]),
  doNotMention: strArr,
});

export const ExtractionOutputSchema = z.object({
  facts: z.array(z.object({
    kind: z.enum(FACT_KINDS),
    key: str.min(1).max(120),
    value: str.min(1).max(2000),
    confidence: z.number().min(0).max(1),
    sourceEventIndex: z.number().int().min(0).nullable().default(null),
    supersedesKey: str.nullable().default(null),
  })).default([]),
  profile: ContextProfileSchema,
  summary: str,
  nextBestActions: z.array(z.object({ action: str, rationale: str.nullable().default(null), channel: str.nullable().default(null) })).default([]),
});

export const GenerationOutputSchema = z.object({
  title: str.min(1).max(300),
  body: str.min(1),
  format: z.enum(["MARKDOWN", "HTML", "TEXT"]),
  structured: z.record(z.string(), z.unknown()).default({}),
  assumptions: strArr,
  missingInformation: strArr,
  suggestedSubject: str.nullable().default(null),
  usedEventIndexes: z.array(z.number().int()).default([]),
});

export const ProjectProposalSchema = z.object({
  project: z.object({
    name: str.min(1).max(200),
    description: str.max(20000),
    status: z.enum(["Planning", "Active"]).default("Planning"),
    startDate: str.nullable().default(null),
    endDate: str.nullable().default(null),
    tags: strArr,
    deliverables: str.nullable().default(null),
    constraints: str.nullable().default(null),
    targetTimeline: str.nullable().default(null),
  }),
  brief: z.object({
    title: str.min(1).max(255),
    objectives: str,
    requirements: z.array(z.object({
      key: str, title: str, description: str,
      acceptanceCriteria: z.array(str).min(1).max(30),
      classification: z.enum(["REQUIREMENT", "CLARIFICATION", "DEFECT", "SCOPE_CHANGE", "ACCEPTANCE"]).default("REQUIREMENT"),
      priority: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
    })).min(1),
    assumptions: strArr, exclusions: strArr, constraints: strArr, questions: strArr,
  }),
  tasks: z.array(z.object({
    key: str, parentKey: str.nullable().default(null), name: str, description: str,
    requirementKeys: strArr, effortMinutes: z.number().int().min(0),
    estimateConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    isMilestone: z.boolean().default(false),
  })).default([]),
  rationale: str,
});

export const AskOutputSchema = z.object({
  answer: str,
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  citedEventIndexes: z.array(z.number().int()).default([]),
  followUpQuestions: strArr,
});

// ── Document templates ───────────────────────────────────────────────────────
// Each kind: what the draft must contain + default format. `structured` hints
// tell the model which machine-readable block to return alongside the body.
export const DOCUMENT_TEMPLATES = Object.freeze({
  EMAIL: { format: "MARKDOWN", guidance: "A single email. Subject line in suggestedSubject. Greeting using their preferred name, 2-5 short paragraphs, one clear next step, professional sign-off placeholder [STAFF NAME]. structured: { subject, callToAction }." },
  SMS: { format: "TEXT", guidance: "One SMS, at most 320 characters, no markdown, one clear action, no links unless present in the record. structured: { characterCount }." },
  CHAT_REPLY: { format: "TEXT", guidance: "A web-chat reply from a CSR: friendly, 1-3 sentences, answers the latest customer message, offers the next step. structured: { intent, sentiment }." },
  QUOTATION: { format: "MARKDOWN", guidance: "A quotation: client details, scope per service line with description, quantity, unit price and line total (only amounts present in the record), subtotal, discounts, total, currency, validity, payment terms, exclusions, next steps. structured: { lines:[{service, description, quantity, unitPrice, total}], currency, subtotal, discount, total, validUntil, paymentTerms }." },
  PROPOSAL: { format: "MARKDOWN", guidance: "A service proposal: understanding of the author's goals, recommended package and why, deliverables, process and timeline, investment (amounts only from the record), what we need from the author, next steps. structured: { recommendedServices:[], timelineWeeks, investment }." },
  NDA: { format: "MARKDOWN", guidance: "A mutual non-disclosure agreement draft between the company and the counterparty covering the manuscript and business information: parties, definition of confidential information, obligations, exclusions, term, return/destruction, governing law placeholder [CONFIRM: governing law], signature blocks. Mark as a draft for legal review. structured: { parties:[], termMonths, governingLaw }." },
  CONTRACT: { format: "MARKDOWN", guidance: "A services agreement draft: parties, services and deliverables (from the quotation/proposal in the record), fees and payment schedule, timeline, author responsibilities, revisions policy, intellectual property and rights, confidentiality, termination, liability placeholder, governing law placeholder, signature blocks. Mark as a draft for legal review. structured: { services:[], fees, paymentSchedule:[], termination }." },
  EDITORIAL_ASSESSMENT: { format: "MARKDOWN", guidance: "An editorial assessment memo for the author's manuscript based ONLY on what the record contains about it (synopsis, sample text, stage, genre): overall impression, strengths, areas to develop (structure, voice, pacing, characterisation or argument, market fit), recommended editing level and services, suggested next steps. Be candid and constructive. If no manuscript material is in the record, say an assessment cannot be made yet and list what to request. structured: { recommendedEditingLevel, readinessScore (0-100 or null), keyIssues:[] }." },
  MEETING_SUMMARY: { format: "MARKDOWN", guidance: "A summary of the most recent call/meeting/transcript in the record: attendees, purpose, discussion points, decisions, action items with owner and due date, open questions. structured: { decisions:[], actionItems:[{what, owner, due}] }." },
  PROJECT_BRIEF: { format: "MARKDOWN", guidance: "A project brief for the delivery team: client and book, objectives, scope and deliverables, requirements with acceptance criteria, timeline and milestones, constraints, assumptions, exclusions, open questions, risks. structured: { objectives:[], deliverables:[], milestones:[], risks:[] }." },
  HANDOVER_BRIEF: { format: "MARKDOWN", guidance: "A handover brief for a colleague taking over this relationship: who the counterparty is, history in brief, current status, promises made both ways, sensitivities and preferences, open items, recommended next action. structured: { openItems:[], sensitivities:[] }." },
  CUSTOM: { format: "MARKDOWN", guidance: "Follow the staff instructions exactly; keep the content grounded in the record." },
});

export const isDocumentKind = (kind) => DOCUMENT_KINDS.includes(kind) && Boolean(DOCUMENT_TEMPLATES[kind]);
