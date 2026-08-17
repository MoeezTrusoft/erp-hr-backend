import asyncHandler from 'express-async-handler';
import * as timeEntryService from '../services/timeEntryService.js';
import { requireEmployeeActor, resolveEmployeeActor } from '../lib/employeeActor.js';

// @desc    Get time entries for employee
// @route   GET /api/time-attendance/entries
// @access  Private
export const getTimeEntries = asyncHandler(async (req, res) => {
    const { startDate, endDate, employeeId } = req.query;
    // REQ-HR-004: an EMPLOYEE is always pinned to their own record (hard
    // requirement). Anyone else may pass an explicit employeeId; when they do
    // not, fall back to their own record IF they have one — an operator account
    // with no linked Employee gets the tenant-wide list rather than a 403.
    const targetEmployeeId = req.user?.role === 'EMPLOYEE'
        ? await requireEmployeeActor(req.user)
        : employeeId || await resolveEmployeeActor(req.user);
    const entries = await timeEntryService.getTimeEntries({
        employeeId: targetEmployeeId,
        startDate,
        endDate,
        tenantId: req.user?.tenantId
    });

    res.json({
        success: true,
        data: entries
    });
});

// @desc    Create time entry
// @route   POST /api/time-attendance/entries
// @access  Private
export const createTimeEntry = asyncHandler(async (req, res) => {

    // On-behalf create: an explicit body.employeeId (manager/HR acting for another
    // employee, gated upstream by hr:attendance CREATE) wins; otherwise fall back
    // to the caller's own employee id from the session header (self-service).
    const employeeId = req.user?.role === 'EMPLOYEE'
        ? await requireEmployeeActor(req.user)
        : req.body.employeeId || await requireEmployeeActor(req.user);
    const entryData = {
        ...req.body,
        employeeId: employeeId,
        tenantId: req.user?.tenantId,
    };

    const entry = await timeEntryService.createTimeEntry(entryData);

    res.status(201).json({
        success: true,
        data: entry
    });
});

// @desc    Update time entry
// @route   PUT /api/time-attendance/entries/:id
// @access  Private
export const updateTimeEntry = asyncHandler(async (req, res) => {
    const employeeId = await requireEmployeeActor(req.user);
    const entry = await timeEntryService.updateTimeEntry(req.params.id, req.body, employeeId, req.user?.tenantId, req.user?.isAdmin);

    res.json({
        success: true,
        data: entry
    });
});

// @desc    Delete time entry
// @route   DELETE /api/time-attendance/entries/:id
// @access  Private
export const deleteTimeEntry = asyncHandler(async (req, res) => {
    const employeeId = await requireEmployeeActor(req.user);
    await timeEntryService.deleteTimeEntry(req.params.id, employeeId, req.user?.tenantId, req.user?.isAdmin);

    res.json({
        success: true,
        message: 'Time entry deleted successfully'
    });
});

// @desc    Clock in
// @route   POST /api/time-attendance/clock-in
// @access  Private
export const clockIn = asyncHandler(async (req, res) => {

    const employeeId = await requireEmployeeActor(req.user);
    const { location, note, sourceId } = req.body;

    const entry = await timeEntryService.clockIn({
        employeeId:employeeId,
        location,
        note,
        sourceId
    });

    res.status(201).json({
        success: true,
        data: entry,
        message: 'Clocked in successfully'
    });
});

// @desc    Clock out
// @route   POST /api/time-attendance/clock-out
// @access  Private
export const clockOut = asyncHandler(async (req, res) => {
    const employeeId = await requireEmployeeActor(req.user);
    const { location, note, sourceId } = req.body;

    const entry = await timeEntryService.clockOut({
        employeeId: employeeId,
        location,
        note,
        sourceId
    });

    res.json({
        success: true,
        data: entry,
        message: 'Clocked out successfully'
    });
});

// @desc    Start break
// @route   POST /api/time-attendance/break-start
// @access  Private
export const startBreak = asyncHandler(async (req, res) => {
    const employeeId = await requireEmployeeActor(req.user);
    const { note, sourceId } = req.body;

    const entry = await timeEntryService.startBreak({
        employeeId: employeeId,
        note,
        sourceId
    });

    res.status(201).json({
        success: true,
        data: entry,
        message: 'Break started'
    });
});

// @desc    End break
// @route   POST /api/time-attendance/break-end
// @access  Private
export const endBreak = asyncHandler(async (req, res) => {
    const employeeId = await requireEmployeeActor(req.user);
    const { note, sourceId } = req.body;

    const entry = await timeEntryService.endBreak({
        employeeId: employeeId,
        note,
        sourceId
    });

    res.json({
        success: true,
        data: entry,
        message: 'Break ended'
    });
});

// @desc    Get current clock status
// @route   GET /api/time-attendance/current-status
// @access  Private
export const getCurrentStatus = asyncHandler(async (req, res) => {
    const status = await timeEntryService.getCurrentStatus(await requireEmployeeActor(req.user));

    res.json({
        success: true,
        data: status
    });
});
