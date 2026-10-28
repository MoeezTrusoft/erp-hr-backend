import { jest, describe, it, expect } from '@jest/globals';
import { z } from 'zod';

const methods = ['createPerformanceReview', 'getAllReviews', 'getEmployeeNineBox',
  'getReviewsByEmployee', 'updateReview', 'addFeedback', 'updateFeedback', 'deleteFeedback'];
const services = Object.fromEntries(methods.map(name => [name, jest.fn()]));
jest.unstable_mockModule('../../src/services/performance.service.js', () => services);
const controllers = await import('../../src/controllers/performance.controller.js');
const routes = methods.map(name => [name, name === 'getEmployeeNineBox' ? 'listEmployeeNineBox' : name]);

describe.each(routes)('%s error boundary', (serviceName, controllerName) => {
  const invoke = async error => {
    services[serviceName].mockRejectedValueOnce(error);
    const req = { body: {}, params: {}, query: {}, headers: {}, user: { tenantId: 'company' },
      correlationId: 'test-correlation', log: { error: jest.fn(), warn: jest.fn() } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await controllers[controllerName](req, res);
    return res;
  };
  it('does not disclose raw database errors', async () => {
    const res = await invoke(new Error('SELECT private_salary FROM confidential_table at secret/server.js'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/private_salary|confidential_table|secret\/server/);
    expect(res.json.mock.calls[0][0].error.code).toBe('HR-5000');
  });
  it('preserves denied and missing-resource statuses', async () => {
    for (const status of [401, 403, 404, 409, 412]) {
      const res = await invoke(Object.assign(new Error('Request rejected'), { status }));
      expect(res.status).toHaveBeenCalledWith(status);
    }
  });
  it('returns structured validation errors', async () => {
    const invalid = z.object({ rating: z.number().max(5) }).safeParse({ rating: 6 });
    const res = await invoke(invalid.error);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('HR-1000');
  });
});
