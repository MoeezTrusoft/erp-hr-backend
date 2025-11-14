import asyncHandler from 'express-async-handler';
import * as timeEntryService from '../services/timeEntryService.js';

// @desc    Get time entries for employee
// @route   GET /api/time-attendance/entries
// @access  Private
export const getTimeEntries = asyncHandler(async (req, res) => {
    const { startDate, endDate, employeeId } = req.query;
    const entries = await timeEntryService.getTimeEntries({
        employeeId: employeeId || req.user.id,
        startDate,
        endDate
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

    const employeeId = req.headers['employee-id'];
    const entryData = {
        ...req.body,
        employeeId: employeeId
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
   const  userId = req.headers['employee-id'];
    const entry = await timeEntryService.updateTimeEntry(req.params.id, req.body, userId);

    res.json({
        success: true,
        data: entry
    });
});

// @desc    Delete time entry
// @route   DELETE /api/time-attendance/entries/:id
// @access  Private
export const deleteTimeEntry = asyncHandler(async (req, res) => {
    const userId = req.headers['employee-id'];
    await timeEntryService.deleteTimeEntry(req.params.id, userId);

    res.json({
        success: true,
        message: 'Time entry deleted successfully'
    });
});

// @desc    Clock in
// @route   POST /api/time-attendance/clock-in
// @access  Private
export const clockIn = asyncHandler(async (req, res) => {

    const employeeId = req.headers['employee-id'];
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
    const employeeId = req.headers['employee-id'];
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
    const employeeId = req.headers['employee-id'];
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
    const employeeId = req.headers['employee-id'];
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
    const status = await timeEntryService.getCurrentStatus(req.user.id);

    res.json({
        success: true,
        data: status
    });
});