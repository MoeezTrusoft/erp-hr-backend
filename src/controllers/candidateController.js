// src/controllers/candidateController.js
import * as candidateService from "../services/candidateService.js";
import { uploadFileToDAM } from "../services/dam.media.service.js";


export const createCandidate = async (req, res) => {
    try {
        const user = req.headers['user-id'];

        const tenantId = user.tenantId ?? null;
        const createdById = user||user.employeeId || user.id || null;

        const {
            firstName,
            lastName,
            email,
            phone,
            source,
            notes,
            tags, // array of tag names
        } = req.body;

        if (!firstName || !email) {
            return res.status(400).json({
                success: false,
                message: "firstName and email are required",
            });
        }

        const candidate = await candidateService.createCandidate({
            firstName,
            lastName,
            email,
            phone,
            source,
            notes,
            tagNames: Array.isArray(tags) ? tags : [],
            tenantId,
            createdById,
        });

        return res.status(201).json({
            success: true,
            message: "Candidate created successfully",
            data: candidate,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const updateCandidate = async (req, res) => {
    try {
        const user = req.headers['user-id'];
        const tenantId = user.tenantId ?? null;
        const updatedById = user||user.employeeId || user.id || null;
        const { id } = req.params;

        const {
            firstName,
            lastName,
            phone,
            source,
            notes,
            status,
            tags, // array of tag names
        } = req.body;

        const candidate = await candidateService.updateCandidate({
            id: Number(id),
            tenantId,
            data: {
                firstName,
                lastName,
                phone,
                source,
                notes,
                status,
            },
            tagNames: Array.isArray(tags) ? tags : undefined,
            updatedById,
        });

        if (!candidate) {
            return res.status(404).json({
                success: false,
                message: "Candidate not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Candidate updated successfully",
            data: candidate,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const getCandidate = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { id } = req.params;

        const candidate = await candidateService.getCandidate({
            id: Number(id),
            tenantId,
        });

        if (!candidate) {
            return res.status(404).json({
                success: false,
                message: "Candidate not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Success",
            data: candidate,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

export const uploadCandidateResume = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const file = req.files[0];
        const uploaded = await uploadFileToDAM(file, "document");
        if (!uploaded || !uploaded[0]) {
            return res.status(500).json({ success: false, message: "DAM upload failed" });
        }
        const mediaId = uploaded[0].id;
        const candidate = await candidateService.updateCandidateResumeMedia({ id, mediaId });
        return res.status(200).json({ success: true, message: "Success", data: candidate });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const listCandidates = async (req, res) => {
    try {
        const user = req.user || {};
        const tenantId = user.tenantId ?? null;
        const { search, tags, page, limit } = req.query;

        const tagIds = tags
            ? String(tags)
                .split(",")
                .map((t) => Number(t))
                .filter(Boolean)
            : [];

        const result = await candidateService.listCandidates({
            tenantId,
            search,
            tagIds,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
        });

        return res.status(200).json({
            success: true,
            message: "Success",
            data: result,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};
