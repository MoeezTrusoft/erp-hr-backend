import * as svc from "../services/offer.service.js";
import { respondServerError, respondPreconditionAware } from '../utils/httpError.js';
import { approveOffer } from "../services/offerApproval.service.js";
import { getOfferHandoff, runOfferHandoff } from "../services/recruitmentHandoff.service.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";

export const createOffer = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        const createdById = req.user?.employeeId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.createOffer({ ...req.body, createdById, tenantId });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getOffer = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        // Phase 1.4 — an offer outside the caller's record scope reads as not-found.
        const result = await svc.getOffer(req.params.id, tenantId, resolveRecruitmentScope(req.user));
        if (!result) return res.status(404).json({ success: false, message: "Not found" });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listOffers = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.listOffers({
            page: Number(page) || 1,
            limit: Number(limit) || 20,
            tenantId,
            scope: resolveRecruitmentScope(req.user),
        });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { respondServerError(req, res, e); }
};

export const approve = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        const approverId = req.user?.employeeId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await approveOffer({
            offerId: req.params.id,
            stage: req.body?.stage,
            decision: req.body?.decision,
            reason: req.body?.reason,
            approverId,
            tenantId,
        });
        return res.status(200).json({ success: true, data: result });
    } catch (e) { return res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

export const sendOffer = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.sendOffer(req.params.id, tenantId, { actorId: req.user?.employeeId ?? req.user?.userId ?? null });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const respondOffer = async (req, res) => {
    try {
        const { accepted } = req.body;
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.respondOffer(req.params.id, accepted, tenantId, {
            actorId: req.user?.employeeId ?? null,
        });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

export const getHandoff = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await getOfferHandoff({ offerId: req.params.id, tenantId });
        res.status(200).json({ success: true, data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

// Operator retry for a FAILED handoff. Idempotent: a COMPLETED handoff replays.
export const retryHandoff = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await runOfferHandoff({
            offerId: req.params.id,
            tenantId,
            actorId: req.user?.employeeId ?? null,
        });
        res.status(200).json({ success: true, data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

export const uploadOfferLetter = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.uploadOfferLetter(req.params.id, req.files[0], tenantId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const updateOffer = async (req, res) => {
    try {
        const { id } = req.params;
        const tenantId = req.user?.tenantId ?? null;
        if (!tenantId) return res.status(400).json({ success: false, message: "Tenant context is required" });
        const result = await svc.updateOffer(id, req.body, tenantId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) {
        // API-2 — surface a stale-write as 412 (HR-4120) with currentVersion.
        if (respondPreconditionAware(res, e)) return;
        res.status(400).json({ success: false, message: e.message });
    }
};
