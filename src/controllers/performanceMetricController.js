// src/controllers/performanceMetricController.js
import * as metricService from "../services/performanceMetricService.js";
import { respondServerError } from '../utils/httpError.js';

export const createMetric = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const createdById = user.employeeId || user.id || null;
        const { name, description, category } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: "name is required",
            });
        }

        const metric = await metricService.createMetric({
            name,
            description,
            category,
            tenantId,
            createdById,
        });

        return res.status(201).json({
            success: true,
            message: "Metric created successfully",
            data: metric,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const listMetrics = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { search, page, limit } = req.query;

        const result = await metricService.listMetrics({
            tenantId,
            search,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 50,
        });

        return res.status(200).json({
            success: true,
            data: result,
        });
    } catch (error) {
        return respondServerError(req, res, error);
    }
};

export const deactivateMetric = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { id } = req.params;

        await metricService.deactivateMetric({
            id: Number(id),
            tenantId,
        });

        return res.status(204).send();
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const upsertReviewItems = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { reviewId } = req.params;
        const { items } = req.body; // [{ metricId, rating, comment }]

        const updated = await metricService.upsertReviewItems({
            reviewId: Number(reviewId),
            tenantId,
            items: Array.isArray(items) ? items : [],
        });

        return res.status(200).json({
            success: true,
            data: updated,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const getReviewItems = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { reviewId } = req.params;

        const list = await metricService.getReviewItems({
            reviewId: Number(reviewId),
            tenantId,
        });

        return res.status(200).json({
            success: true,
            data: list,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};
