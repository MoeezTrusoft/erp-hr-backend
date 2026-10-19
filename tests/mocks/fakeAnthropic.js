// tests/mocks/fakeAnthropic.js — deterministic stand-in for the Anthropic
// client used by src/services/engagement/claude.client.js. It picks the
// structured output by the task line in the (cached) system prompt.
export const EXTRACTION_OUTPUT = {
  facts: [
    { kind: 'PROJECT_DETAIL', key: 'manuscript.word_count', value: '82,000 words', confidence: 0.9, sourceEventIndex: 0, supersedesKey: null },
    { kind: 'BUDGET', key: 'budget.band', value: 'USD 4,000–6,000', confidence: 0.7, sourceEventIndex: 0, supersedesKey: null },
  ],
  profile: {
    identity: { fullName: 'Amina Raza', preferredName: 'Amina', organization: null, roleTitle: null, location: null, timezone: null, language: 'en', contactPreferences: [{ channel: 'EMAIL', note: 'prefers email' }] },
    publishing: { authorType: 'first-time', genres: ['memoir'], titles: [{ title: 'Salt and Sky', genre: 'memoir', manuscriptStage: 'complete draft', wordCount: 82000, formats: ['paperback', 'ebook'], status: null }], servicesDiscussed: ['developmental editing', 'cover design'], servicesPurchased: [], targetAudience: null, goals: ['publish by spring'], platformsOfInterest: ['Amazon KDP'] },
    commercial: { budgetBand: 'USD 4,000–6,000', budgetNotes: null, currency: 'USD', quotedAmounts: [], paymentTerms: null, purchasingAuthority: 'self', decisionMakers: [], ndaStatus: null, contractStatus: null },
    timeline: { targetPublicationDate: '2027-04-01', hardDeadlines: [], agreedMilestones: [] },
    relationship: { stage: 'QUALIFIED', sentiment: 'POSITIVE', intent: 'buy editing package', communicationStyle: 'warm, detailed', responsiveness: 'same day', trustSignals: [], frictionPoints: [] },
    commitments: { ours: [{ what: 'send quotation', by: '2026-10-22', status: 'open' }], theirs: [] },
    decisions: [], objections: [], openQuestions: ['Does she have a cover concept?'], riskFlags: [], doNotMention: [],
  },
  summary: 'Amina Raza is a first-time memoir author with a complete 82,000-word draft, Salt and Sky. She wants developmental editing and cover design within a USD 4-6k budget and hopes to publish by spring 2027. We promised a quotation by 22 October.',
  nextBestActions: [{ action: 'Send the quotation for editing + cover design', rationale: 'promised', channel: 'EMAIL' }],
};

export const GENERATION_OUTPUT = {
  title: 'Your quotation for Salt and Sky',
  body: 'Dear Amina,\n\nThank you for sharing Salt and Sky...\n\n[STAFF NAME]',
  format: 'MARKDOWN',
  structured: { subject: 'Your quotation for Salt and Sky', callToAction: 'Reply to confirm' },
  assumptions: [],
  missingInformation: ['[CONFIRM: delivery date]'],
  suggestedSubject: 'Your quotation for Salt and Sky',
  usedEventIndexes: [0],
};

export const PROJECT_OUTPUT = {
  project: { name: 'Salt and Sky — editing and cover', description: 'Developmental edit and cover design for a memoir', status: 'Planning', startDate: null, endDate: null, tags: ['memoir'], deliverables: 'Edited manuscript; cover files', constraints: 'Publish by spring 2027', targetTimeline: '20 weeks' },
  brief: {
    title: 'Salt and Sky', objectives: 'Deliver a publication-ready memoir',
    requirements: [{ key: 'R1', title: 'Developmental edit', description: 'Full developmental edit of 82,000 words', acceptanceCriteria: ['Editorial letter delivered'], classification: 'REQUIREMENT', priority: 'HIGH' }],
    assumptions: [], exclusions: ['Marketing'], constraints: [], questions: ['Cover concept?'],
  },
  tasks: [{ key: 'T1', parentKey: null, name: 'Developmental edit', description: 'Edit', requirementKeys: ['R1'], effortMinutes: 2400, estimateConfidence: 'MEDIUM', isMilestone: false }],
  rationale: 'Scope follows the quotation discussed on 20 October.',
};

export const ASK_OUTPUT = { answer: 'She has a complete draft of 82,000 words.', confidence: 'HIGH', citedEventIndexes: [0], followUpQuestions: [] };

export function pickOutput(request) {
  const system = request.system?.[0]?.text ?? '';
  if (system.includes("Task: update the counterparty's context profile")) return EXTRACTION_OUTPUT;
  if (system.includes('Task: draft a document')) return GENERATION_OUTPUT;
  if (system.includes('Task: turn the counterparty')) return PROJECT_OUTPUT;
  if (system.includes('Task: answer the staff question')) return ASK_OUTPUT;
  throw new Error('fakeAnthropic: unknown purpose');
}

export function createFakeAnthropic({ stopReason = 'end_turn', override } = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (request) => {
          calls.push(request);
          const output = override ? override(request) : pickOutput(request);
          return {
            model: request.model,
            stop_reason: stopReason,
            usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: JSON.stringify(output) }],
          };
        },
      },
    },
  };
}
