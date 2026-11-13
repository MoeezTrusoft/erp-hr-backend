import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { events } from '@trusoft/contracts';

const uuid = z.string().uuid();
const positive = z.number().int().positive();
const fail = message => { throw Object.assign(new Error(message), { code: 'HR-5030', status: 503 }); };
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('Appraisal notification endpoint is not configured'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    fail('Appraisal notification endpoints require credential-free HTTPS URLs');
  return url.href.replace(/\/$/, '');
}

// Service credentials are selected only by the worker's verified tenant. Never
// accept URLs, recipients, tokens or message text from appraisal command input.
export function createAppraisalNotificationClient({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  async function post(url, body, token) {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(token ? { 'x-service-authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) fail(`Appraisal notification dependency returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 65536) fail('Appraisal notification dependency response is too large');
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const frames = text.split(/\r?\n/).filter(line => line.startsWith('data:'));
      if (!frames.length) fail('Appraisal identity response is empty');
      return JSON.parse(frames.at(-1).slice(5));
    }
    return JSON.parse(text);
  }
  return async function deliver({ tenantId, employeeId, userId, intentId, reviewId, stage, dueAt }) {
    uuid.parse(tenantId); uuid.parse(intentId); uuid.parse(reviewId);
    positive.parse(employeeId); positive.parse(userId);
    if (!/^(SELF|MANAGER)_\d{4}-\d{2}-\d{2}$/.test(stage)) fail('Unsupported appraisal reminder stage');
    const rbac = endpoint(environment.RBAC_SERVICE_URL);
    const hub = endpoint(environment.APPRAISAL_NOTIFICATION_ENDPOINT);
    let credentials;
    try { credentials = JSON.parse(environment.APPRAISAL_NOTIFICATION_CREDENTIALS_JSON || '{}')[tenantId]; }
    catch { fail('Invalid appraisal notification credential configuration'); }
    if (!credentials?.clientId || !credentials?.clientSecret) fail('Appraisal notification service credentials are missing for this company');
    const grant = await post(`${rbac}/api/v1/service-accounts/token`, {
      grant_type: 'client_credentials', clientId: credentials.clientId,
      clientSecret: credentials.clientSecret, scope: 'rbac.user.read',
    });
    let claims;
    try { claims = JSON.parse(Buffer.from(grant.access_token.split('.')[1], 'base64url')); }
    catch { fail('Appraisal notification service token is invalid'); }
    if (claims.tid !== tenantId || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() + 15000)
      fail('Appraisal notification service token has the wrong company or expiry');
    const id = randomUUID();
    const rpc = await post(`${rbac}/mcp`, { jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'rbac_user_resolve', arguments: { userId } } }, grant.access_token);
    if (rpc.id !== id || rpc.error || rpc.result?.isError) fail('Appraisal recipient lookup failed');
    const identity = rpc.result?.structuredContent ?? JSON.parse(rpc.result?.content?.find(item => item.type === 'text')?.text || 'null');
    if (identity?.userId !== userId || Number(identity?.employeeId) !== employeeId)
      fail('Appraisal recipient identity does not match this employee');
    const recipient = uuid.parse(identity.userUuid);
    const request = events.NotifyRequest.parse({
      tenantId, recipients: [{ userId: recipient }],
      templateId: stage.startsWith('SELF_') ? 'hr.performance.self_due' : 'hr.performance.manager_due',
      data: { dueDate: new Date(dueAt).toISOString().slice(0, 10) },
      channels: ['in_app'], category: 'hr.performance', priority: 'normal',
      entityRef: `/hr/performance/${stage.startsWith('SELF_') ? 'me' : 'team'}?reviewId=${reviewId}`,
      dedupeKey: `appraisal-reminder:${tenantId}:${intentId}`,
    });
    const receipt = await post(hub, request, grant.access_token);
    // Acceptance is distinct from channel delivery; never label this DELIVERED.
    return { notificationId: uuid.parse(receipt.notificationId) };
  };
}
