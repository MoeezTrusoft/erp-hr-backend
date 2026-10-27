// src/controllers/applicationController.js
import * as applicationService from "../services/application.service.js";
import { respondServerError } from '../utils/httpError.js';
import { resolveRecruitmentScope } from '../lib/recruitment-access.util.js';

// A service refusal keeps its own 4xx (409 HR-RECRUITMENT-CANDIDATE-DNC, 404);
// anything else stays the historical 400.
const clientErrorStatus = (error) => {
    const status = Number(error?.status);
    return status >= 400 && status < 500 ? status : 400;
};

export const createApplication = async (req, res) => {
    try {
        const actor = req.user || {};
        const tenantId = actor.tenantId ?? null;
        const createdById = actor.employeeId ?? null;

        const { candidateId, requisitionId, jobRequisitionId: bodyJobRequisitionId, stage, status, sourceChannel, sourceDetail } = req.body;
        const jobRequisitionId = bodyJobRequisitionId || requisitionId;

        if (!candidateId || !jobRequisitionId) {
            return res.status(400).json({
                success: false,
                message: "candidateId and jobRequisitionId are required",
            });
        }

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: "Tenant context is required",
            });
        }

        const app = await applicationService.createApplication({
            candidateId,
            jobRequisitionId,
            stage,
            status,
            tenantId,
            createdById,
            sourceChannel,
            sourceDetail,
        });

        return res.status(201).json({
            success: true,
            message: "Application created successfully",
            data: app,
        });
    } catch (error) {
        return res.status(clientErrorStatus(error)).json({
            success: false,
            message: error.message,
            ...(error?.code ? { code: error.code } : {}),
        });
    }
};

export const listApplications = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        if (!tenantId) return respondServerError(req, res, Object.assign(new Error("Tenant context is required"), { status: 400 }));
        const { jobRequisitionId, candidateId, stage, status, page, limit } =
            req.query;

        const result = await applicationService.listApplications({
            tenantId,
            // Phase 1.4 — applications are row-scoped too, not just tenant-scoped.
            scope: resolveRecruitmentScope(user),
            jobRequisitionId: jobRequisitionId ? Number(jobRequisitionId) : undefined,
            candidateId: candidateId ? Number(candidateId) : undefined,
            stage,
            status,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
        });

        return res.status(200).json({
            success: true,
            data: result,
        });
    } catch (error) {
        return respondServerError(req, res, error);
    }
};

export const updateStage = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const updatedById = user.employeeId ?? null;
        const { id } = req.params;
        const { stage, reason } = req.body;

        if (!stage) {
            return res.status(400).json({
                success: false,
                message: "stage is required",
            });
        }
        if (!tenantId) {
            return res.status(400).json({ success: false, message: "Tenant context is required" });
        }

        await applicationService.updateApplicationStage({
            id: Number(id),
            tenantId,
            stage,
            reason,
            updatedById
        });

        return res.status(204).send();
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const updateStatus = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const updatedById = user.employeeId ?? null;
        const { id } = req.params;
        const { status, reason } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                message: "status is required",
            });
        }
        if (!tenantId) {
            return res.status(400).json({ success: false, message: "Tenant context is required" });
        }

        await applicationService.updateApplicationStatus({
            id: Number(id),
            tenantId,
            status,
            reason,
            updatedById
        });

        return res.status(204).send();
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};
