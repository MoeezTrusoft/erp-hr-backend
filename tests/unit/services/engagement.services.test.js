// tests/unit/services/engagement.services.test.js — pure units of the
// Engagement Context Engine: redaction, timeline mapping, context rendering
// and token budgeting, PM payload/brief shaping, receipts, state machine.
import { jest, describe, it, expect } from '@jest/globals';

import { createFakePrisma } from '../../mocks/fakePrisma.js';
import { PROJECT_OUTPUT } from '../../mocks/fakeAnthropic.js';

const fakePrisma = createFakePrisma();
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: fakePrisma }));

const { redactSensitive } = await import('../../../src/services/engagement/redaction.js');
const { mapTimelineItem, EventInputSchema } = await import('../../../src/services/engagement/ingest.service.js');
const { renderContext, renderEvent, loadEventWindow } = await import('../../../src/services/engagement/context-builder.js');
const { toPmProjectPayload, toBriefContent } = await import('../../../src/services/engagement/project-sync.service.js');
const { withReceipt } = await import('../../../src/services/engagement/receipts.js');
const { DOCUMENT_TRANSITIONS, normalizePhone, normalizeEmail } = await import('../../../src/services/engagement/base.js');
const { ProjectProposalSchema, ExtractionOutputSchema, DOCUMENT_TEMPLATES } = await import('../../../src/services/engagement/prompts.js');
const { mapSourceRecord } = await import('../../../src/services/engagement/inbox.service.js');
const { mcpCtx } = await import('../../../src/lib/requestContext.js');

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const env = { tenantId: TENANT, user: { tenantId: TENANT, userId: '1' }, permissions: [], actorId: '1' };

describe('redaction', () => {
  it('masks payment instruments, identity numbers and secrets but keeps commercial text', () => {
    const text = 'Budget USD 5,000. Card 4111 1111 1111 1111, IBAN PK36SCBL0000001123456702, CNIC 35202-1234567-1, password: hunter2.';
    const out = redactSensitive(text);
    expect(out).toContain('Budget USD 5,000');
    expect(out).toContain('[REDACTED:CARD]');
    expect(out).toContain('[REDACTED:IBAN]');
    expect(out).toContain('[REDACTED:CNIC]');
    expect(out).toContain('[REDACTED:SECRET]');
    expect(out).not.toContain('hunter2');
  });
});

describe('timeline mapping', () => {
  it('turns a call with a transcript into a TRANSCRIPT event and keeps provenance', () => {
    const mapped = mapTimelineItem({ id: 'call-1', channel: 'CALL', direction: 'inbound', sender: '+1 555 0100', occurredAt: '2026-10-01T10:00:00Z', durationSec: 120, transcript: { segments: [{ speaker: 'customer', text: 'hello' }] } }, { partyId: '11111111-1111-4111-8111-111111111111', threadId: 'thr' });
    expect(mapped).toMatchObject({ channel: 'TRANSCRIPT', direction: 'INBOUND', sourceSystem: 'COMMUNICATION_THREAD', sourceId: 'call-1', sourceThreadId: 'thr' });
    expect(mapped.body).toContain('customer: hello');
    expect(mapped.participants).toContain('from +1 555 0100');
    expect(() => EventInputSchema.parse(mapped)).not.toThrow();
  });
  it('maps fax to DOCUMENT and unknown channels to NOTE, bot actors to OUTBOUND', () => {
    expect(mapTimelineItem({ channel: 'FAX', body: 'x' }, { partyId: '11111111-1111-4111-8111-111111111111' }).channel).toBe('DOCUMENT');
    expect(mapTimelineItem({ channel: 'WHATEVER', body: 'x', actorType: 'BOT' }, { partyId: '11111111-1111-4111-8111-111111111111' })).toMatchObject({ channel: 'NOTE', direction: 'OUTBOUND' });
  });
  it('maps fabric mail/sms/transcript records', () => {
    const mail = mapSourceRecord('comms.mail.received.v1', { fromEmail: 'a@b.c', fromName: 'A', toAddresses: ['csr@acme.test'], subject: 'Hi', bodyHtml: '<p>Hello <b>there</b></p>', date: '2026-10-01T00:00:00Z', threadId: 9 });
    expect(mail).toMatchObject({ resolve: { emails: ['a@b.c'], displayName: 'A' }, body: 'Hello there', sourceThreadId: '9' });
    const sms = mapSourceRecord('comms.sms.sent.v1', { phone: '+10000', body: 'ok' });
    expect(sms.resolve.phones).toEqual(['+10000']);
    const tr = mapSourceRecord('comms.call.transcript_published.v1', { transcript: { segments: [{ speaker: 'agent', text: 'yes' }], sentiment: 'positive' }, contactId: 5 });
    expect(tr.body).toContain('agent: yes');
    expect(tr.resolve.identities[0]).toEqual({ system: 'COMMUNICATION_CONTACT', externalId: '5' });
  });
});

describe('context rendering and budgeting', () => {
  it('renders indexed events and the profile, newest-first budget keeps the most recent', async () => {
    const partyId = '22222222-2222-4222-8222-222222222222';
    await mcpCtx.run({ user: env.user }, async () => {
      for (let i = 0; i < 5; i += 1) {
        await fakePrisma.engagementEvent.create({ data: { tenantId: TENANT, partyId, channel: 'NOTE', dedupeKey: `k${i}`, occurredAt: new Date(2026, 9, i + 1), body: 'x'.repeat(4000), bodyHash: `h${i}` } });
      }
      const events = await loadEventWindow(fakePrisma, env, partyId, { tokenBudget: 2200 });
      expect(events).toHaveLength(2);
      expect(events[0].occurredAt < events[1].occurredAt).toBe(true);
      const text = renderContext({ party: { displayName: 'P', role: 'LEAD', stage: 'NEW' }, profile: null, facts: [], events });
      expect(text).toContain('[#0]');
      expect(text).toContain('[#1]');
      expect(text).toContain('CURRENT PROFILE (version 0)');
    });
  });
  it('renderEvent includes participants, subject and attachments', () => {
    const line = renderEvent({ occurredAt: new Date('2026-10-01T00:00:00Z'), channel: 'EMAIL', direction: 'INBOUND', participants: [{ role: 'from', address: 'a@b.c' }], subject: 'S', attachments: [{ name: 'ms.docx' }], body: 'B' }, 3);
    expect(line).toContain('[#3] 2026-10-01T00:00:00.000Z EMAIL INBOUND');
    expect(line).toContain('participants: from a@b.c');
    expect(line).toContain('attachments: ms.docx');
  });
});

describe('PM payload shaping', () => {
  const proposal = ProjectProposalSchema.parse(PROJECT_OUTPUT);
  it('builds a project_project_create payload within the PM contract', () => {
    const payload = toPmProjectPayload(proposal);
    expect(payload).toMatchObject({ name: proposal.project.name, status: 'Planning' });
    expect(payload.configuration).toMatchObject({ planningMode: 'ai', tags: ['memoir'] });
    expect(payload.configuration.aiPlanningBrief).toContain('Developmental edit');
    expect(payload.projectId).toBeUndefined();
  });
  it('builds an update payload with projectId and expectedVersion', () => {
    expect(toPmProjectPayload(proposal, { pmProjectId: 5, expectedVersion: 2 })).toMatchObject({ projectId: 5, expectedVersion: 2 });
  });
  it('shapes a BriefContent for project_brief_save', () => {
    const brief = toBriefContent(proposal);
    expect(brief.requirements[0]).toMatchObject({ key: 'R1', evidenceIds: [], classification: 'REQUIREMENT', priority: 'HIGH' });
    expect(brief.requirements[0].acceptanceCriteria.length).toBeGreaterThan(0);
  });
});

describe('receipts', () => {
  it('replays the same payload and rejects a different one', async () => {
    const tx = fakePrisma;
    let runs = 0;
    const run = async () => ({ value: ++runs });
    const a = await withReceipt(tx, { tenantId: TENANT, requestKey: 'k1', toolName: 't', payload: { x: 1 } }, run);
    const b = await withReceipt(tx, { tenantId: TENANT, requestKey: 'k1', toolName: 't', payload: { x: 1 } }, run);
    expect(a).toEqual({ result: { value: 1 }, replayed: false });
    expect(b).toEqual({ result: { value: 1 }, replayed: true });
    await expect(withReceipt(tx, { tenantId: TENANT, requestKey: 'k1', toolName: 't', payload: { x: 2 } }, run)).rejects.toMatchObject({ code: 'HR-4706' });
    expect(runs).toBe(1);
  });
});

describe('contracts and vocabularies', () => {
  it('document state machine is explicit and terminal at ARCHIVED', () => {
    expect(DOCUMENT_TRANSITIONS.DRAFT).toContain('APPROVED');
    expect(DOCUMENT_TRANSITIONS.SENT).toEqual(['ARCHIVED']);
    expect(DOCUMENT_TRANSITIONS.ARCHIVED).toEqual([]);
  });
  it('every document kind has a template with a format', () => {
    for (const [kind, t] of Object.entries(DOCUMENT_TEMPLATES)) expect(['MARKDOWN', 'HTML', 'TEXT']).toContain(t.format);
    expect(Object.keys(DOCUMENT_TEMPLATES)).toHaveLength(12);
  });
  it('extraction schema fills defaults for sparse model output', () => {
    const parsed = ExtractionOutputSchema.parse({ facts: [], profile: {}, summary: 's' });
    expect(parsed.profile.relationship.sentiment).toBe('UNKNOWN');
    expect(parsed.nextBestActions).toEqual([]);
  });
  it('normalises contact points', () => {
    expect(normalizeEmail(' A@B.Com ')).toBe('a@b.com');
    expect(normalizePhone('+92 (300) 123-4567')).toBe('+923001234567');
  });
});
