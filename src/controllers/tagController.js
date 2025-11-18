// src/controllers/tagController.js
import * as tagService from "../services/tagService.js";

export const listTags = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { search, page, limit } = req.query;

        const result = await tagService.listTags({
            tenantId,
            search,
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

export const createTag = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const createdById = user.employeeId || user.id || null;

        const { name, type } = req.body;
        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Tag name is required",
            });
        }

        const tag = await tagService.createTag({
            name,
            type,
            tenantId,
            createdById,
        });

        return res.status(201).json({
            success: true,
            message: "Tag created successfully",
            data: tag,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const deactivateTag = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { id } = req.params;

        await tagService.deactivateTag({
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
