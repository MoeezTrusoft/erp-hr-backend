import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createLibreSignClient } from './libresignClient.mjs';

const occ = (...args) => execFileSync('docker', ['compose', 'exec', '-T', '--user', 'www-data', 'app', 'php', 'occ', ...args], { encoding: 'utf8', timeout: 20000 }).trim();
assert.equal(occ('config:system:get', 'mail_smtphost'), 'mailpit', 'Company isolation smoke requires the isolated test mailbox');
assert.equal(occ('config:app:get', 'core', 'shareapi_enabled'), 'no', 'Dedicated requestor accounts must not share files');
const baseUrl = 'http://127.0.0.1:5398';
const bytes = await readFile('.runtime/synthetic-offer.pdf');
const document = { offerId: 900000002, version: 1, sha256: createHash('sha256').update(bytes).digest('hex') };
const fixtures = [];
for (const suffix of ['009997', '009998']) {
  const tenantId = '00000000-0000-4000-8000-000000' + suffix;
  const username = 'erp-recruitment-' + tenantId;
  const appPassword = (await readFile('.secrets/' + tenantId + '.app-password', 'utf8')).trim();
  const user = JSON.parse(occ('user:info', username, '--output=json'));
  assert.ok(user.groups.includes('recruitment-signers'));
  assert.ok(!user.groups.includes('admin'));
  fixtures.push({ tenantId, username, auth: 'Basic ' + Buffer.from(username + ':' + appPassword).toString('base64'), client: createLibreSignClient({ tenantId, baseUrl, username, appPassword, allowLocalHttp: true, timeoutMs: 60000 }) });
}
try {
  for (const f of fixtures) {
    const uploaded = await f.client.prepareDocument(document, bytes);
    f.expected = { ...uploaded, email: 'isolation-' + f.tenantId + '@example.invalid', displayName: 'Fictional company isolation signer' };
    f.workflow = await f.client.reconcile(f.expected) ?? await f.client.requestSignature(f.expected);
  }
  assert.notEqual(fixtures[0].expected.nodeId, fixtures[1].expected.nodeId);
  assert.notEqual(fixtures[0].workflow.fileId, fixtures[1].workflow.fileId);
  for (let i = 0; i < fixtures.length; i++) {
    const owner = fixtures[i], other = fixtures[1 - i];
    assert.equal(await other.client.reconcile(owner.expected), null, 'Other company must not discover the workflow');
    const response = await fetch(baseUrl + '/remote.php/dav/files/' + owner.username + '/RecruitmentOffers/' + owner.tenantId + '/' + owner.expected.name + '.pdf', { headers: { Authorization: other.auth }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    assert.ok([403, 404].includes(response.status), 'Other company must not download the PDF');
    assert.equal((await owner.client.reconcile(owner.expected)).fileId, owner.workflow.fileId);
  }
  console.log('PASS distinct company requestors, non-admin groups, private workflows and denied cross-company PDF downloads');
} finally {
  for (const f of fixtures) if (f.expected) await f.client.erase(f.expected, document);
}
console.log('PASS synthetic company documents erased');
