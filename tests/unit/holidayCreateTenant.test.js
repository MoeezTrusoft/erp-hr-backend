import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const created = [];
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    holidayCalendar: { findFirst: jest.fn(async () => ({ tenantId: 'tenant-1' })) },
    holiday: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => { created.push(data); return { id: 1, ...data }; }),
    },
  },
}));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn(async () => {}) }));

const { createHoliday } = await import('../../src/services/holiday.service.js');

describe('createHoliday', () => {
  beforeEach(() => { created.length = 0; });

  it('stamps the calendar company on the new holiday (the table rejects a row without one)', async () => {
    await createHoliday({ holidayCalendarId: 19, name: 'Iqbal Day', date: '2099-11-09' }, 558);
    expect(created[0]).toMatchObject({ tenantId: 'tenant-1', holidayCalendarId: 19, name: 'Iqbal Day' });
  });
});
