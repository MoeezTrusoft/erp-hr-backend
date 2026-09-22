// src/controllers/applicationScreening.controller.js
//
// Phase 6 / decision record §4.1–4.3 — REST surface for screening records,
// disposition reason codes and the requisition shortlist. Mounted under
// /api/recruitment, so routeAuthorization resolves everything here to the
// hr.recruitment resource with the method-derived action — one policy model,
// nothing to drift.

import {
    recordScreening,
    listScreenings,
    listDispositionReasons,
    versionDispositionReason,
    deactivateDispositionReason,
    addToShortlist,
    listShortlist,
    removeFromShortlist,
    ScreeningError,
} from "../services/applicationScreening.service.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";

const tenantOf = (req) => req.user?.tenantId ?? null;
const actorOf = (req) => req.user?.employeeId ?? null;

// The service throws ApplicationQuestionError-style { status, details }; a flat
// 400 would hide the per-field validation list from the recruiter's UI.
const respond = (res, error) => {
    const status = Number(error?.status) || 400;
    const body = { success: false, message: error.message, code: error.code };
    if (error?.details !== undefined) body.details = error.details;
    return res.status(status).json(body);
};

// ── §4.1 screening records ───────────────────────────────────────────────────

export const recordScreeningHandler = async (req, res) => {
    try {
        const { outcome, reasonCode, notes, criteria } = req.body ?? {};
        const row = await recordScreening({
            applicationId: req.params.id,
            tenantId: tenantOf(req),
            outcome,
            reasonCode: reasonCode ?? null,
            notes: notes ?? null,
            criteria: criteria ?? null,
            actorId: actorOf(req),
        });
        res.status(201).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const listScreeningsHandler = async (req, res) => {
    try {
        const rows = await listScreenings(req.params.id, tenantOf(req));
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        respond(res, error);
    }
};

// ── §4.2 reason codes ────────────────────────────────────────────────────────

export const listDispositionReasonsHandler = async (req, res) => {
    try {
        const rows = await listDispositionReasons(tenantOf(req));
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        respond(res, error);
    }
};

export const versionDispositionReasonHandler = async (req, res) => {
    try {
        const { code, label, requiresNotes } = req.body ?? {};
        const row = await versionDispositionReason({
            tenantId: tenantOf(req),
            code,
            label,
            requiresNotes: requiresNotes === true,
            actorId: actorOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const deactivateDispositionReasonHandler = async (req, res) => {
    try {
        const row = await deactivateDispositionReason(tenantOf(req), req.params.code);
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

// ── §4.3 shortlist ───────────────────────────────────────────────────────────

export const addToShortlistHandler = async (req, res) => {
    try {
        const { note } = req.body ?? {};
        const row = await addToShortlist({
            applicationId: req.params.id,
            tenantId: tenantOf(req),
            note: note ?? null,
            actorId: actorOf(req),
        });
        res.status(201).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const listShortlistHandler = async (req, res) => {
    try {
        const rows = await listShortlist(req.params.requisitionId, tenantOf(req), resolveRecruitmentScope(req.user));
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        respond(res, error);
    }
};

export const removeFromShortlistHandler = async (req, res) => {
    try {
        const row = await removeFromShortlist({ applicationId: req.params.id, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export { ScreeningError };
