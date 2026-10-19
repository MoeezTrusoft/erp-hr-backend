// tests/unit/mcp/engagement.tools.scenarios.test.js — Engagement Context
// Engine facade: registration, deny-by-default, and the end-to-end flows
// (ingest → refresh → generate → transition → propose → confirm/sync → ask)
// against the in-memory Prisma double and a deterministic Anthropic stand-in.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import { createFakePrisma } from '../../mocks/fakePrisma.js';
import { createFakeAnthropic, EXTRACTION_OUTPUT } from '../../mocks/fakeAnthropic.js';

const fakePrisma = createFakePrisma();
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: fakePrisma }));

const { registerEngagementTools } = await import('../../../src/mcp/tools/engagementTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');
const { setAnthropicClientFactory } = await import('../../../src/services/engagement/claude.client.js');
const { setPmTransport } = await import('../../../src/services/engagement/pm-mcp.client.js');

const handlers = new Map();
registerEngagementTools({ tool: (n, ...r) => handlers.set(n, r[r.length - 1]), resource: () => {} });

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const USER = { userId: '7', email: 'csr@acme.test', roles: ['SALES'], isAdmin: false, employeeId: '7', tenantId: TENANT };
const GRANT = { 'hr:engagement': ['VIEW', 'CREATE', 'EDIT'] };
const call = (name, args, { user = USER, permissions = GRANT } = {}) =>
  mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const EXPECTED_TOOLS = [
  'hr_engagement_party_list', 'hr_engagement_party_get', 'hr_engagement_party_create', 'hr_engagement_party_update',
  'hr_engagement_party_resolve', 'hr_engagement_identity_link', 'hr_engagement_party_merge',
  'hr_engagement_event_ingest', 'hr_engagement_event_list', 'hr_engagement_thread_import',
  'hr_engagement_profile_get', 'hr_engagement_profile_refresh', 'hr_engagement_fact_list', 'hr_engagement_fact_update',
  'hr_engagement_document_generate', 'hr_engagement_document_list', 'hr_engagement_document_get',
  'hr_engagement_document_update', 'hr_engagement_document_transition',
  'hr_engagement_project_propose', 'hr_engagement_project_link_list', 'hr_engagement_project_confirm', 'hr_engagement_project_sync',
  'hr_engagement_context_ask', 'hr_engagement_catalog_get',
];

let fakeAnthropic;
beforeEach(() => {
  fakeAnthropic = createFakeAnthropic();
  setAnthropicClientFactory(() => fakeAnthropic);
  setPmTransport(null);
});

describe('ENGAGEMENT — registration', () => {
  it('registers every tool under the hr_ prefix', () => {
    expect([...handlers.keys()].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const name of handlers.keys()) expect(name).toMatch(/^hr_engagement_[a-z_]+$/);
  });
});

describe('ENGAGEMENT — authorization', () => {
  it.each(EXPECTED_TOOLS)('%s: no permission → 403', async (name) => {
    const res = await call(name, {}, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });
  it('forged isAdmin without entitlement → 403', async () => {
    const res = await call('hr_engagement_party_list', {}, { user: { ...USER, isAdmin: true }, permissions: {} });
    expect(parse(res).status).toBe(403);
  });
  it('no verified identity → 401', async () => {
    const res = await mcpCtx.run({}, () => handlers.get('hr_engagement_party_list')({}));
    expect(parse(res).status).toBe(401);
  });
  it('VIEW-only scope cannot ingest', async () => {
    const res = await call('hr_engagement_event_ingest', { partyId: '11111111-1111-4111-8111-111111111111', channel: 'NOTE', body: 'x' }, { permissions: { 'hr:engagement': ['VIEW'] } });
    expect(parse(res).status).toBe(403);
  });
  it('dotted MCP scope array is honoured', async () => {
    const res = await call('hr_engagement_catalog_get', {}, { permissions: ['hr.engagement.read'] });
    expect(res.isError).toBeUndefined();
    expect(parse(res).documentKinds.length).toBe(12);
  });
});

describe('ENGAGEMENT — relationship flow', () => {
  let partyId;
  it('creates a party (idempotent via requestKey)', async () => {
    const input = { displayName: 'Amina Raza', role: 'LEAD', emails: ['Amina@Example.com'], phones: ['+92 300 1234567'], requestKey: 'req-party-0001' };
    const first = parse(await call('hr_engagement_party_create', input));
    const replay = parse(await call('hr_engagement_party_create', input));
    expect(first.id).toBe(replay.id);
    expect(first.emails).toEqual(['amina@example.com']);
    expect(first.phones).toEqual(['+923001234567']);
    partyId = first.id;
    const conflict = await call('hr_engagement_party_create', { ...input, displayName: 'Other' });
    expect(parse(conflict).code).toBe('HR-4706');
  });

  it('ingests events, deduplicates and resolves by email', async () => {
    const res = parse(await call('hr_engagement_event_ingest', {
      resolve: { emails: ['amina@example.com'] }, channel: 'EMAIL', direction: 'INBOUND', sourceSystem: 'MAIL', sourceId: 'INBOX/42',
      subject: 'My memoir', body: 'Hi, my memoir Salt and Sky is 82,000 words. Budget around 4-6k USD. Card 4111 1111 1111 1111.', occurredAt: '2026-10-20T09:00:00.000Z',
    }));
    expect(res.duplicate).toBe(false);
    expect(res.partyId).toBe(partyId);
    const again = parse(await call('hr_engagement_event_ingest', { partyId, channel: 'EMAIL', sourceSystem: 'MAIL', sourceId: 'INBOX/42', body: 'different' }));
    expect(again.duplicate).toBe(true);
    const unknown = parse(await call('hr_engagement_event_ingest', { resolve: { emails: ['new@example.com'], displayName: 'New Visitor' }, channel: 'WEBCHAT', body: 'hello' }));
    expect(unknown.partyId).not.toBe(partyId);
    const list = parse(await call('hr_engagement_event_list', { partyId }));
    expect(list.items).toHaveLength(1);
    const outbox = fakePrisma.__tables.outboxEvent.map((r) => r.eventName);
    expect(outbox).toContain('engagement.event.ingested.v1');
  });

  it('imports a communication thread timeline', async () => {
    const res = parse(await call('hr_engagement_thread_import', {
      partyId, threadId: 'thr-1',
      items: [
        { id: 'call-9', channel: 'CALL', direction: 'INBOUND', sender: '+923001234567', occurredAt: '2026-10-21T10:00:00Z', durationSec: 600, transcript: { segments: [{ speaker: 'customer', text: 'I would like a quote by Thursday.' }] } },
        { id: 'sms-3', channel: 'SMS', direction: 'OUTBOUND', body: 'Thanks, we will send it.', occurredAt: '2026-10-21T10:30:00Z' },
        { id: 'sms-3', channel: 'SMS', direction: 'OUTBOUND', body: 'Thanks, we will send it.', occurredAt: '2026-10-21T10:30:00Z' },
      ],
    }));
    expect(res).toMatchObject({ imported: 2, duplicates: 1 });
    const list = parse(await call('hr_engagement_event_list', { partyId }));
    expect(list.items.map((e) => e.channel).sort()).toEqual(['EMAIL', 'SMS', 'TRANSCRIPT']);
  });

  it('refreshes the profile with the LLM, writes facts with provenance and redacts C4', async () => {
    const before = parse(await call('hr_engagement_profile_get', { partyId }));
    expect(before.pendingEvents).toBe(3);
    const res = parse(await call('hr_engagement_profile_refresh', { partyId }));
    expect(res.profile.version).toBe(1);
    expect(res.newFacts).toBe(2);
    expect(res.eventsProcessed).toBe(3);
    expect(res.profile.summary).toMatch(/Amina/);
    expect(res.profile.structured.relationship.sentiment).toBe('POSITIVE');
    const prompt = fakeAnthropic.calls[0].messages[0].content;
    expect(prompt).toContain('[REDACTED:CARD]');
    expect(prompt).not.toContain('4111 1111 1111 1111');
    expect(fakeAnthropic.calls[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(fakeAnthropic.calls[0].fallbacks).toBe('default');
    const after = parse(await call('hr_engagement_profile_get', { partyId }));
    expect(after.pendingEvents).toBe(0);
    expect(after.facts.find((f) => f.key === 'manuscript.word_count').sourceEventId).toBeTruthy();
    const noop = parse(await call('hr_engagement_profile_refresh', { partyId }));
    expect(noop.skipped).toBe(true);
    expect(fakePrisma.__tables.engagementLlmRun.filter((r) => r.purpose === 'EXTRACT')).toHaveLength(1);
  });

  it('supersedes a fact on refresh and lets staff retract', async () => {
    await call('hr_engagement_event_ingest', { partyId, channel: 'NOTE', body: 'Author corrected the word count to 90,000.', occurredAt: '2026-10-22T09:00:00Z' });
    fakeAnthropic = createFakeAnthropic({ override: () => ({
      ...EXTRACTION_OUTPUT, facts: [{ kind: 'PROJECT_DETAIL', key: 'manuscript.word_count', value: '90,000 words', confidence: 0.95, sourceEventIndex: 0, supersedesKey: 'manuscript.word_count' }],
    }) });
    setAnthropicClientFactory(() => fakeAnthropic);
    const res = parse(await call('hr_engagement_profile_refresh', { partyId }));
    expect(res.supersededFacts).toBe(1);
    const facts = parse(await call('hr_engagement_fact_list', { partyId, status: 'ACTIVE' })).items;
    const wc = facts.filter((f) => f.key === 'manuscript.word_count');
    expect(wc).toHaveLength(1);
    expect(wc[0].value).toBe('90,000 words');
    const retracted = parse(await call('hr_engagement_fact_update', { factId: wc[0].id, status: 'RETRACTED', reason: 'wrong' }));
    expect(retracted.status).toBe('RETRACTED');
  });

  let documentId;
  it('generates a grounded document draft and walks the state machine', async () => {
    const doc = parse(await call('hr_engagement_document_generate', { partyId, kind: 'EMAIL', instructions: 'Send the quotation', requestKey: 'req-doc-0001' }));
    expect(doc.status).toBe('DRAFT');
    expect(doc.kind).toBe('EMAIL');
    expect(doc.sourceEventIds.length).toBeGreaterThan(0);
    expect(doc.llmRunId).toBeTruthy();
    documentId = doc.id;
    const replay = parse(await call('hr_engagement_document_generate', { partyId, kind: 'EMAIL', instructions: 'Send the quotation', requestKey: 'req-doc-0001' }));
    expect(replay.id).toBe(documentId);
    const edited = parse(await call('hr_engagement_document_update', { documentId, expectedVersion: 1, body: 'Dear Amina, edited.' }));
    expect(edited.version).toBe(2);
    const stale = await call('hr_engagement_document_update', { documentId, expectedVersion: 1, body: 'x' });
    expect(parse(stale).status).toBe(412);
    const bad = await call('hr_engagement_document_transition', { documentId, expectedVersion: 2, to: 'SENT' });
    expect(parse(bad).code).toBe('HR-4710');
    const approved = parse(await call('hr_engagement_document_transition', { documentId, expectedVersion: 2, to: 'APPROVED' }));
    expect(approved.approvedByUserId).toBe('7');
    const sent = parse(await call('hr_engagement_document_transition', { documentId, expectedVersion: 3, to: 'SENT', deliveryRef: 'mail:INBOX/77' }));
    expect(sent.status).toBe('SENT');
    const events = parse(await call('hr_engagement_event_list', { partyId })).items;
    expect(events.find((e) => e.sourceSystem === 'ENGAGEMENT_DOCUMENT')).toMatchObject({ channel: 'EMAIL', direction: 'OUTBOUND' });
    const docs = parse(await call('hr_engagement_document_list', { partyId, status: 'SENT' }));
    expect(docs.items).toHaveLength(1);
  });

  let linkId;
  it('proposes a PM project and records a frontend-created project', async () => {
    const { link, replayed } = parse(await call('hr_engagement_project_propose', { partyId, documentId, requestKey: 'req-proj-0001' }));
    expect(replayed).toBe(false);
    expect(link.status).toBe('PROPOSED');
    expect(link.proposal.pmPayload).toMatchObject({ name: 'Salt and Sky — editing and cover', status: 'Planning' });
    expect(link.proposal.pmPayload.configuration.planningMode).toBe('ai');
    expect(link.brief.requirements[0]).toMatchObject({ key: 'R1', evidenceIds: [] });
    linkId = link.id;
    const again = parse(await call('hr_engagement_project_propose', { partyId, requestKey: 'req-proj-0001' }));
    expect(again.replayed).toBe(true);
    const confirmed = parse(await call('hr_engagement_project_confirm', { linkId, pmProjectId: 321, status: 'CREATED' }));
    expect(confirmed).toMatchObject({ pmProjectId: 321, status: 'CREATED' });
  });

  it('syncs server-side through the PM MCP (update needs expectedProjectVersion)', async () => {
    const seen = [];
    setPmTransport(async (rpc) => {
      seen.push(rpc);
      return { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: 321, etag: '2' }) }] } };
    });
    const missing = await call('hr_engagement_project_sync', { linkId });
    expect(parse(missing).code).toBe('HR-4700');
    const synced = parse(await call('hr_engagement_project_sync', { linkId, expectedProjectVersion: 1 }));
    expect(synced.status).toBe('UPDATED');
    expect(seen[0].params.name).toBe('project_project_update');
    expect(seen[0].params.arguments).toMatchObject({ projectId: 321, expectedVersion: 1 });
    setPmTransport(async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'PM down', data: { code: 'PM-5000' } } }));
    const failed = parse(await call('hr_engagement_project_sync', { linkId, expectedProjectVersion: 2 }));
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toMatch(/PM down/);
  });

  it('answers questions with citations', async () => {
    const res = parse(await call('hr_engagement_context_ask', { partyId, question: 'How long is the manuscript?' }));
    expect(res.answer).toMatch(/82,000/);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0].eventId).toBeTruthy();
  });

  it('merges a duplicate party into the survivor', async () => {
    const dup = parse(await call('hr_engagement_party_create', { displayName: 'A. Raza', emails: ['amina.raza@gmail.com'] }));
    await call('hr_engagement_event_ingest', { partyId: dup.id, channel: 'SMS', body: 'ping' });
    const res = parse(await call('hr_engagement_party_merge', { sourcePartyId: dup.id, targetPartyId: partyId, reason: 'same person' }));
    expect(res.moved.engagementEvent).toBe(1);
    const survivor = parse(await call('hr_engagement_party_get', { partyId }));
    expect(survivor.party.emails).toEqual(expect.arrayContaining(['amina@example.com', 'amina.raza@gmail.com']));
    expect(survivor.profile.refreshStatus).toBe('QUEUED');
    const resolved = parse(await call('hr_engagement_party_resolve', { emails: ['amina.raza@gmail.com'] }));
    expect(resolved.id).toBe(partyId);
    const list = parse(await call('hr_engagement_party_list', { q: 'raza' }));
    expect(list.items.map((p) => p.id)).toContain(partyId);
    expect(list.items.map((p) => p.id)).not.toContain(dup.id);
  });

  it('maps a model refusal to HR-4704 and a missing key to HR-4703', async () => {
    setAnthropicClientFactory(() => createFakeAnthropic({ stopReason: 'refusal' }));
    const refused = await call('hr_engagement_document_generate', { partyId, kind: 'SMS' });
    expect(parse(refused).code).toBe('HR-4704');
    setAnthropicClientFactory(null);
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const unconfigured = await call('hr_engagement_context_ask', { partyId, question: 'anything?' });
    expect(parse(unconfigured).status).toBe(503);
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  });
});
