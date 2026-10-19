// src/controllers/interviewSchedule.controller.js
//
// Phase 7 / decision record §5.1–5.4 — REST surface for the interview
// scheduling lifecycle. Mounted under /api/recruitment like the rest of the
// recruitment slice, so routeAuthorization resolves everything to the
// hr.recruitment resource with the method-derived action.

import {
    cancelInterview,
    requestReschedule,
    confirmReschedule,
    checkInterviewerAvailability,
    markCalendarSync,
    listLifecycleEvents,
    ScheduleError,
} from "../services/interviewSchedule.service.js";

const tenantOf = (req) => req.user?.tenantId ?? null;
const actorOf = (req) => req.user?.employeeId ?? null;

const respond = (res, error) => {
    const status = Number(error?.status) || 400;
    const body = { success: false, message: error.message, code: error.code };
    if (error?.details !== undefined) body.details = error.details;
    return res.status(status).json(body);
};

// ── §5.4 cancel ──────────────────────────────────────────────────────────────

export const cancelInterviewHandler = async (req, res) => {
    try {
        const { reasonCode, notes } = req.body ?? {};
        const row = await cancelInterview({
            interviewId: req.params.id,
            reasonCode,
            notes: notes ?? null,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

// ── §5.3/5.3a reschedule ─────────────────────────────────────────────────────

export const requestRescheduleHandler = async (req, res) => {
    try {
        const { reasonCode, notes, requestedFor } = req.body ?? {};
        const row = await requestReschedule({
            interviewId: req.params.id,
            reasonCode,
            notes: notes ?? null,
            requestedFor: requestedFor ?? null,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(201).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const confirmRescheduleHandler = async (req, res) => {
    try {
        const { scheduledAt, reasonCode, notes, override, overrideReason } = req.body ?? {};
        const row = await confirmReschedule({
            interviewId: req.params.id,
            scheduledAt,
            reasonCode,
            notes: notes ?? null,
            override: override === true,
            overrideReason: overrideReason ?? null,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

// ── §5.2/5.2a availability ───────────────────────────────────────────────────

export const availabilityHandler = async (req, res) => {
    try {
        const { scheduledAt, durationMinutes, interviewerIds } = req.body ?? {};
        const result = await checkInterviewerAvailability({
            scheduledAt,
            durationMinutes,
            interviewerIds: Array.isArray(interviewerIds) ? interviewerIds : String(interviewerIds ?? "").split(","),
            tenantId: tenantOf(req),
        });
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        respond(res, error);
    }
};

// ── §5.1a/5.1b calendar linkage ──────────────────────────────────────────────

export const markCalendarSyncHandler = async (req, res) => {
    try {
        const { provider, calendarEventId, status } = req.body ?? {};
        const row = await markCalendarSync({
            interviewId: req.params.id,
            provider,
            calendarEventId,
            status,
            tenantId: tenantOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

// ── lifecycle history (the §5.4 ledger, read side) ──────────────────────────

export const listLifecycleEventsHandler = async (req, res) => {
    try {
        const rows = await listLifecycleEvents({ interviewId: req.params.id, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        respond(res, error);
    }
};

export { ScheduleError };
