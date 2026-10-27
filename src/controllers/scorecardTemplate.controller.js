// src/controllers/scorecardTemplate.controller.js
//
// Phase 7 / decision record §5.5–5.5b — REST surface for scorecard templates.
// Mounted under /api/recruitment; routeAuthorization resolves everything here
// to the hr.recruitment resource with the method-derived action.

import {
    createTemplate,
    updateTemplate,
    deactivateTemplate,
    listTemplates,
    linkTemplate,
    unlinkTemplate,
    resolveForInterview,
    TemplateError,
} from "../services/scorecard-template.service.js";

const tenantOf = (req) => req.user?.tenantId ?? null;
const actorOf = (req) => req.user?.employeeId ?? null;

const respond = (res, error) => {
    const status = Number(error?.status) || 400;
    const body = { success: false, message: error.message, code: error.code };
    if (error?.details !== undefined) body.details = error.details;
    return res.status(status).json(body);
};

export const createTemplateHandler = async (req, res) => {
    try {
        const { name, description, criteria } = req.body ?? {};
        const row = await createTemplate({
            name,
            description: description ?? null,
            criteria,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(201).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const updateTemplateHandler = async (req, res) => {
    try {
        const { name, description, criteria } = req.body ?? {};
        const row = await updateTemplate({
            templateId: req.params.id,
            name,
            description,
            criteria,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const deactivateTemplateHandler = async (req, res) => {
    try {
        const row = await deactivateTemplate({
            templateId: req.params.id,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const listTemplatesHandler = async (req, res) => {
    try {
        const rows = await listTemplates({
            tenantId: tenantOf(req),
            includeInactive: req.query.includeInactive === "true",
        });
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        respond(res, error);
    }
};

export const linkTemplateHandler = async (req, res) => {
    try {
        const { templateId, scopeType, scopeId, scopeKey } = req.body ?? {};
        const row = await linkTemplate({
            templateId,
            scopeType,
            scopeId,
            scopeKey,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(201).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const unlinkTemplateHandler = async (req, res) => {
    try {
        const row = await unlinkTemplate({ linkId: req.params.linkId, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const resolveTemplateHandler = async (req, res) => {
    try {
        const row = await resolveForInterview({ interviewId: req.params.id, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export { TemplateError };
