import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAppraisalNotificationClient } from '../../src/services/appraisals/notification-client.js';

const tenantId = randomUUID(), userUuid = randomUUID(), notificationId = randomUUID();
const input = { tenantId, employeeId: 24, userId: 91, intentId: randomUUID(), reviewId: randomUUID(), stage: 'SELF_2026-10-28', dueAt: new Date('2026-10-27') };
const environment = { RBAC_SERVICE_URL: 'https://rbac.test', APPRAISAL_NOTIFICATION_ENDPOINT: 'https://hub.test/api/v1/notify',
  APPRAISAL_NOTIFICATION_CREDENTIALS_JSON: JSON.stringify({ [tenantId]: { clientId: 'test', clientSecret: 'synthetic' } }) };
function setup({ wrongTenant = false, wrongEmployee = false, badReceipt = false, sse = false } = {}) {
  const calls = [];
  const deliver = createAppraisalNotificationClient({ environment, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, options });
    let data;
    if (url.endsWith('/token')) data = { access_token: `header.${Buffer.from(JSON.stringify({ tid: wrongTenant ? randomUUID() : tenantId, exp: Math.floor(Date.now()/1000)+60 })).toString('base64url')}.signature` };
    else if (url.endsWith('/mcp')) data = { jsonrpc: '2.0', id: body.id, result: { structuredContent: { userId: 91, employeeId: wrongEmployee ? 25 : 24, userUuid } } };
    else data = { notificationId: badReceipt ? 'not-a-receipt' : notificationId };
    const isSse = sse && url.endsWith('/mcp');
    return new Response(isSse ? `event: message\ndata: ${JSON.stringify(data)}\n\n` : JSON.stringify(data),
      { status: 200, headers: { 'content-type': isSse ? 'text/event-stream' : 'application/json' } });
  } });
  return { deliver, calls };
}
test('Appraisal Hub request resolves employee identity and uses a stable replay key without review content', async () => {
  const { deliver, calls } = setup({ sse: true });
  assert.deepEqual(await deliver(input), { notificationId });
  await deliver(input);
  const requests = calls.filter(c => c.url.includes('hub.test'));
  assert.equal(requests[0].body.dedupeKey, requests[1].body.dedupeKey);
  assert.deepEqual(requests[0].body.recipients, [{ userId: userUuid }]);
  assert.deepEqual(requests[0].body.data, { dueDate: '2026-10-27' });
  assert.equal(requests[0].body.templateId, 'hr.performance.self_due');
  assert.ok(calls.every(c => c.options.redirect === 'error' && c.options.signal));
});
test('Cross-company tokens and mismatched employee mappings never reach Notification Hub', async () => {
  for (const options of [{ wrongTenant: true }, { wrongEmployee: true }]) {
    const { deliver, calls } = setup(options);
    await assert.rejects(deliver(input));
    assert.equal(calls.some(c => c.url.includes('hub.test')), false);
  }
});
test('Missing credentials, insecure endpoints and unconfirmed receipts fail closed', async () => {
  await assert.rejects(setup({ badReceipt: true }).deliver(input));
  for (const overrides of [{ APPRAISAL_NOTIFICATION_CREDENTIALS_JSON: '{}' }, { RBAC_SERVICE_URL: 'http://rbac.test' }]) {
    let called = false;
    const deliver = createAppraisalNotificationClient({ environment: { ...environment, ...overrides }, fetchImpl: async () => { called = true; } });
    await assert.rejects(deliver(input));
    assert.equal(called, false);
  }
});
