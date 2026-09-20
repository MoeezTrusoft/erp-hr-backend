// src/controllers/candidatePrivacy.controller.js
//
// Phase 2.5 / 10 — REST surface for candidate privacy: consent, DNC, legal hold,
// retention, anonymization and data-subject requests.
//
// Tenant scope is the VERIFIED claim (req.user.tenantId) and the actor is the
// verified employee — this surface touches statutory personal-data operations, so
// neither may come from a forwarded header. Errors keep the established
// recruitment shape (status + descriptive `code`) so an operator can tell a DNC
// block from a validation failure.
import * as privacy from "../services/candidatePrivacy.service.js";
import { resolveEmployeeActor } from "../lib/employeeActor.js";

const TENANT_REQUIRED = { success: false, code: "HR-TENANT-REQUIRED", message: "Tenant context is required" };

const fail = (res, error) =>
    res.status(error?.status || 400).json({ success: false, code: error?.code, message: error?.message });

export const recordConsentHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.recordConsent({
            tenantId,
            candidateId: req.params.id,
            purpose: req.body?.purpose,
            status: req.body?.status,
            policyVersion: req.body?.policyVersion ?? null,
            source: req.body?.source ?? null,
            evidence: req.body?.evidence ?? null,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(201).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const listConsentHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.listConsent({ tenantId, candidateId: req.params.id });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const recordDncHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.recordDnc({
            tenantId,
            email: req.body?.email,
            candidateId: req.body?.candidateId ?? null,
            reasonCode: req.body?.reasonCode,
            reason: req.body?.reason,
            scope: req.body?.scope ?? "ALL",
            expiresAt: req.body?.expiresAt ?? null,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(201).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const listDncHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.listDnc({ tenantId, status: req.query?.status ?? null, email: req.query?.email ?? null });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const liftDncHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.liftDnc({
            tenantId,
            id: req.params.id,
            reason: req.body?.reason,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const placeLegalHoldHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.placeLegalHold({
            tenantId,
            candidateId: req.params.id,
            reason: req.body?.reason,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(201).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const releaseLegalHoldHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.releaseLegalHold({
            tenantId,
            candidateId: req.params.id,
            reason: req.body?.reason,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const setRetentionPolicyHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.setRetentionPolicy({
            tenantId,
            appliesTo: req.body?.appliesTo,
            retentionMonths: req.body?.retentionMonths,
            legalBasis: req.body?.legalBasis ?? null,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const previewRetentionHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const asOf = req.query?.asOf ? new Date(req.query.asOf) : new Date();
        const result = await privacy.previewRetentionDue({ tenantId, asOf, limit: Number(req.query?.limit) || 100 });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const applyRetentionHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        // dryRun defaults to TRUE: erasure is irreversible, so the destructive
        // path has to be requested explicitly (`dryRun: false`).
        const result = await privacy.applyRetention({
            tenantId,
            asOf: req.body?.asOf ? new Date(req.body.asOf) : new Date(),
            actorId: await resolveEmployeeActor(req.user),
            dryRun: req.body?.dryRun !== false,
            limit: Number(req.body?.limit) || 100,
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const anonymizeCandidateHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.anonymizeCandidate({
            tenantId,
            candidateId: req.params.id,
            reason: req.body?.reason,
            legalBasis: req.body?.legalBasis ?? null,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const createDataAccessRequestHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.recordDataAccessRequest({
            tenantId,
            subjectEmail: req.body?.subjectEmail,
            type: req.body?.type,
            candidateId: req.body?.candidateId ?? null,
            dueAt: req.body?.dueAt ?? null,
            notes: req.body?.notes ?? null,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(201).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const listDataAccessRequestsHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.listDataAccessRequests({ tenantId, status: req.query?.status ?? null });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};

export const closeDataAccessRequestHandler = async (req, res) => {
    const tenantId = req.user?.tenantId ?? null;
    if (!tenantId) return res.status(400).json(TENANT_REQUIRED);
    try {
        const result = await privacy.closeDataAccessRequest({
            tenantId,
            id: req.params.id,
            status: req.body?.status,
            notes: req.body?.notes ?? null,
            rejectionReason: req.body?.rejectionReason ?? null,
            actorId: await resolveEmployeeActor(req.user),
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) { return fail(res, error); }
};
