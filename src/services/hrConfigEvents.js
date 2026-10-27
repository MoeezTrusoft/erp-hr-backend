// Outbox emitters for HR configuration that feeds attendance: holiday
// calendars/days and per-employee work schedules.
//
// The realtime intake on the frontend can only react to events that exist on
// the fabric, and these two aggregates had none — two HR users editing rosters
// or holidays saw each other's changes only after a manual refresh. These
// helpers are deliberately fail-soft: the aggregate write has already
// committed, and a missing outbox model (unit-test prisma mocks) must not turn
// a successful roster save into a 500.
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import { enqueueHrDomainEvent } from './hrDomainEvent.service.js';

const emit = async (args) => {
  try {
    await enqueueHrDomainEvent(prisma, args);
  } catch (err) {
    logger.warn(
      { err: err?.message, eventName: args?.eventName, aggregateId: args?.aggregateId },
      'hr config outbox enqueue failed (non-fatal)'
    );
  }
};

export const emitHolidayCalendarChanged = ({ tenantId, actorId, calendarId, action }) =>
  emit({
    eventName: 'hr.holiday.calendar_changed.v1',
    tenantId,
    actorId,
    aggregateType: 'HolidayCalendar',
    aggregateId: calendarId,
    payload: { calendarId: calendarId == null ? null : String(calendarId), action },
  });

export const emitHolidayChanged = ({ tenantId, actorId, calendarId, date, action }) =>
  emit({
    eventName: 'hr.holiday.changed.v1',
    tenantId,
    actorId,
    aggregateType: 'Holiday',
    aggregateId: date ? `${calendarId}:${date}` : calendarId,
    payload: {
      calendarId: calendarId == null ? null : String(calendarId),
      date: date ? String(date).slice(0, 10) : null,
      action,
    },
  });

export const emitWorkScheduleChanged = ({ tenantId, actorId, scheduleId, action }) =>
  emit({
    eventName: 'hr.work_schedule.changed.v1',
    tenantId,
    actorId,
    aggregateType: 'WorkSchedule',
    aggregateId: scheduleId,
    payload: {
      scheduleId: scheduleId == null ? null : String(scheduleId),
      action,
    },
  });

// Attendance capture (R15). The evidence queue was poll-only on the frontend,
// so two HR operators reviewing the same inbox saw different states until one
// of them hit Refresh. A review can also write attendance days, so this event
// is the signal the timesheet/attendance panels already know how to consume.
export const emitAttendanceCaptureChanged = ({ tenantId, actorId, captureId, action }) =>
  emit({
    eventName: 'hr.attendance.capture_reviewed.v1',
    tenantId,
    actorId,
    aggregateType: 'AttendanceCapture',
    aggregateId: captureId,
    payload: {
      captureId: captureId == null ? null : String(captureId),
      action,
    },
  });

// Device registration / suspension / credential rotation and biometric kiosk
// configuration change the Devices panel (and the enrolment eligibility of every
// kiosk tab) without touching the evidence queue.
export const emitAttendanceDeviceChanged = ({ tenantId, actorId, deviceId, action }) =>
  emit({
    eventName: 'hr.attendance.device_changed.v1',
    tenantId,
    actorId,
    aggregateType: 'AttendanceDevice',
    aggregateId: deviceId,
    payload: {
      deviceId: deviceId == null ? null : String(deviceId),
      action,
    },
  });

export default emitWorkScheduleChanged;
