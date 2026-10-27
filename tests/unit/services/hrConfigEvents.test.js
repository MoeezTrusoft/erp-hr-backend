// tests/unit/services/hrConfigEvents.test.js
//
// Realtime parity for HR configuration: the frontend can only invalidate
// holiday/roster panels if a fabric event exists. These emitters are wired into
// the MCP handlers, so this test pins the contract the FE rules subscribe to
// (`hr.holiday.*`, `hr.work_schedule.*`) and the fail-soft envelope around a
// write that has already committed.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const enqueue = jest.fn(async (_tx, args) => args);

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: { outboxEvent: { create: jest.fn(async () => ({})) } },
}));

jest.unstable_mockModule('../../../src/services/hrDomainEvent.service.js', () => ({
  default: enqueue,
  enqueueHrDomainEvent: enqueue,
}));

const {
  emitHolidayCalendarChanged,
  emitHolidayChanged,
  emitWorkScheduleChanged,
  emitAttendanceCaptureChanged,
  emitAttendanceDeviceChanged,
} = await import('../../../src/services/hrConfigEvents.js');

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

describe('hrConfigEvents — outbox emitters', () => {
  beforeEach(() => {
    enqueue.mockClear();
    enqueue.mockImplementation(async (_tx, args) => args);
  });

  it('publishes a calendar change under the prefix the FE subscribes to', async () => {
    await emitHolidayCalendarChanged({
      tenantId: TENANT,
      actorId: '7',
      calendarId: 4,
      action: 'updated',
    });

    const [, args] = enqueue.mock.calls[0];
    expect(args.eventName).toBe('hr.holiday.calendar_changed.v1');
    expect(args.eventName.startsWith('hr.holiday.')).toBe(true);
    expect(args.aggregateType).toBe('HolidayCalendar');
    expect(args.aggregateId).toBe(4);
    expect(args.payload).toEqual({ calendarId: '4', action: 'updated' });
  });

  it('identifies a holiday day by calendar and ISO date', async () => {
    await emitHolidayChanged({
      tenantId: TENANT,
      actorId: '7',
      calendarId: 4,
      date: '2026-12-25T00:00:00.000Z',
      action: 'created',
    });

    const [, args] = enqueue.mock.calls[0];
    expect(args.eventName).toBe('hr.holiday.changed.v1');
    expect(args.aggregateId).toBe('4:2026-12-25T00:00:00.000Z');
    expect(args.payload.date).toBe('2026-12-25');
  });

  it('publishes roster changes under hr.work_schedule.*', async () => {
    await emitWorkScheduleChanged({
      tenantId: TENANT,
      actorId: '7',
      scheduleId: 'ws-9',
      action: 'deleted',
    });

    const [, args] = enqueue.mock.calls[0];
    expect(args.eventName).toBe('hr.work_schedule.changed.v1');
    expect(args.eventName.startsWith('hr.work_schedule.')).toBe(true);
    expect(args.payload).toEqual({ scheduleId: 'ws-9', action: 'deleted' });
  });

  it('publishes capture reviews under hr.attendance.capture* (R15)', async () => {
    await emitAttendanceCaptureChanged({
      tenantId: TENANT,
      actorId: '7',
      captureId: 'evt-1',
      action: 'capture_review',
    });

    const [, args] = enqueue.mock.calls[0];
    expect(args.eventName).toBe('hr.attendance.capture_reviewed.v1');
    expect(args.eventName.startsWith('hr.attendance.capture')).toBe(true);
    expect(args.aggregateType).toBe('AttendanceCapture');
    expect(args.aggregateId).toBe('evt-1');
    expect(args.payload).toEqual({ captureId: 'evt-1', action: 'capture_review' });
  });

  it('publishes device changes under hr.attendance.device*', async () => {
    await emitAttendanceDeviceChanged({
      tenantId: TENANT,
      actorId: '7',
      deviceId: 'dev-4',
      action: 'device_update',
    });

    const [, args] = enqueue.mock.calls[0];
    expect(args.eventName).toBe('hr.attendance.device_changed.v1');
    expect(args.eventName.startsWith('hr.attendance.device')).toBe(true);
    expect(args.aggregateType).toBe('AttendanceDevice');
    expect(args.payload).toEqual({ deviceId: 'dev-4', action: 'device_update' });
  });

  it('does not fail the committed write when the outbox is unavailable', async () => {
    enqueue.mockRejectedValueOnce(new Error('outbox down'));

    await expect(
      emitWorkScheduleChanged({
        tenantId: TENANT,
        actorId: '7',
        scheduleId: 'ws-9',
        action: 'created',
      })
    ).resolves.toBeUndefined();

    enqueue.mockRejectedValueOnce(new Error('outbox down'));
    await expect(
      emitAttendanceCaptureChanged({
        tenantId: TENANT,
        actorId: '7',
        captureId: 'evt-1',
        action: 'capture_review',
      })
    ).resolves.toBeUndefined();
  });
});
