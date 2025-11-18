// src/controllers/applicationController.js
import * as applicationService from "../services/applicationService.js";

export const createApplication = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const createdById = user.employeeId || user.id || null;

        const { candidateId, jobRequisitionId, stage, status } = req.body;

        if (!candidateId || !jobRequisitionId) {
            return res.status(400).json({
                success: false,
                message: "candidateId and jobRequisitionId are required",
            });
        }

        const app = await applicationService.createApplication({
            candidateId,
            jobRequisitionId,
            stage,
            status,
            tenantId,
            createdById,
        });

        return res.status(201).json({
            success: true,
            message: "Application created successfully",
            data: app,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const listApplications = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { jobRequisitionId, candidateId, stage, status, page, limit } =
            req.query;

        const result = await applicationService.listApplications({
            tenantId,
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
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

export const updateStage = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { id } = req.params;
        const { stage } = req.body;

        if (!stage) {
            return res.status(400).json({
                success: false,
                message: "stage is required",
            });
        }

        await applicationService.updateApplicationStage({
            id: Number(id),
            tenantId,
            stage,
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
        const { id } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                message: "status is required",
            });
        }

        await applicationService.updateApplicationStatus({
            id: Number(id),
            tenantId,
            status,
        });

        return res.status(204).send();
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};
