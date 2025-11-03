import asyncHandler from 'express-async-handler';
import * as timesheetService from '../services/timesheetService.js';

// @desc    Get timesheets for employee
// @route   GET /api/time-attendance/timesheets
// @access  Private
const getTimesheets = asyncHandler(async (req, res) => {
    const { periodStart, periodEnd, status, employeeId } = req.query;

    const timesheets = await timesheetService.getTimesheets({
        employeeId: employeeId || req.user.id,
        periodStart,
        periodEnd,
        status
    });

    res.json({
        success: true,
        data: timesheets
    });
});

// @desc    Get timesheet by ID
// @route   GET /api/time-attendance/timesheets/:id
// @access  Private
const getTimesheetById = asyncHandler(async (req, res) => {
    const timesheet = await timesheetService.getTimesheetById(req.params.id, req.user.id);

    res.json({
        success: true,
        data: timesheet
    });
});

// @desc    Create timesheet
// @route   POST /api/time-attendance/timesheets
// @access  Private
const createTimesheet = asyncHandler(async (req, res) => {
    const timesheetData = {
        ...req.body,
        employeeId: req.body.employeeId || req.user.id
    };

    const timesheet = await timesheetService.createTimesheet(timesheetData);

    res.status(201).json({
        success: true,
        data: timesheet
    });
});

// @desc    Submit timesheet for approval
// @route   POST /api/time-attendance/timesheets/:id/submit
// @access  Private
const submitTimesheet = asyncHandler(async (req, res) => {
    const timesheet = await timesheetService.submitTimesheet(req.params.id, req.user.id);

    res.json({
        success: true,
        data: timesheet,
        message: 'Timesheet submitted for approval'
    });
});

// @desc    Approve timesheet
// @route   POST /api/time-attendance/timesheets/:id/approve
// @access  Private
const approveTimesheet = asyncHandler(async (req, res) => {
    const { comments } = req.body;

    const timesheet = await timesheetService.approveTimesheet(
        req.params.id,
        req.user.id,
        comments
    );

    res.json({
        success: true,
        data: timesheet,
        message: 'Timesheet approved successfully'
    });
});

// @desc    Reject timesheet
// @route   POST /api/time-attendance/timesheets/:id/reject
// @access  Private
const rejectTimesheet = asyncHandler(async (req, res) => {
    const { comments } = req.body;

    const timesheet = await timesheetService.rejectTimesheet(
        req.params.id,
        req.user.id,
        comments
    );

    res.json({
        success: true,
        data: timesheet,
        message: 'Timesheet rejected'
    });
});

export {
    getTimesheets,
    getTimesheetById,
    createTimesheet,
    submitTimesheet,
    approveTimesheet,
    rejectTimesheet
};