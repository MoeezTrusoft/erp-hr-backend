// tests/unit/jobs/engagement.queue.test.js — job wiring is disabled under
// test / without Redis, and profile refreshes de-duplicate per party.
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: {} }));
const { startEngagementJobs, enqueueProfileRefresh, JOB_PROFILE_REFRESH, ENGAGEMENT_QUEUE } = await import('../../../src/jobs/engagement.queue.js');

describe('engagement queue', () => {
  it('returns a disabled handle in test env and without REDIS_URL', async () => {
    const a = startEngagementJobs({ env: { NODE_ENV: 'test', REDIS_URL: 'redis://x' } });
    const b = startEngagementJobs({ env: { NODE_ENV: 'production' } });
    const c = startEngagementJobs({ env: { NODE_ENV: 'production', REDIS_URL: 'redis://x', HR_ENGAGEMENT_JOBS_ENABLED: 'false' } });
    expect([a.enabled, b.enabled, c.enabled]).toEqual([false, false, false]);
    await a.stop();
    expect(await a.enqueueRefresh({})).toBeNull();
  });

  it('starts with injected factories, schedules repeatables and stops cleanly', async () => {
    const added = [];
    const queue = { add: jest.fn(async (name, data, opts) => { added.push({ name, data, opts }); return { id: opts?.jobId }; }), close: jest.fn(async () => {}) };
    const worker = { on: jest.fn(), close: jest.fn(async () => {}) };
    const handle = startEngagementJobs({
      env: { NODE_ENV: 'production', REDIS_URL: 'redis://x' },
      logger: { info: () => {}, warn: () => {}, error: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
      connectionFactory: () => ({ quit: jest.fn(async () => {}), xgroup: jest.fn(), xreadgroup: jest.fn(async () => null) }),
      queueFactory: (name) => (name === ENGAGEMENT_QUEUE ? queue : { add: jest.fn(), close: jest.fn(async () => {}) }),
      workerFactory: () => worker,
    });
    expect(handle.enabled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(added.map((a) => a.opts.jobId)).toEqual(expect.arrayContaining(['repeat:engagement-refresh-sweep', 'repeat:engagement-inbox-drain']));
    const job = await handle.enqueueRefresh({ tenantId: 't', partyId: 'p' });
    expect(job.id).toBe('refresh:t:p');
    const again = await enqueueProfileRefresh(queue, { tenantId: 't', partyId: 'p' });
    expect(again.id).toBe('refresh:t:p');
    const last = added[added.length - 1];
    expect(last.name).toBe(JOB_PROFILE_REFRESH);
    expect(last.opts.attempts).toBe(5);
    await handle.stop();
    expect(worker.close).toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalled();
  });
});
