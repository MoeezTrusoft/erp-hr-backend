import {
    createEmployeeMediaService,
    getAllEmployeeMediaService,
    getEmployeeMediaByIdService,
    updateEmployeeMediaService,
    deleteEmployeeMediaService,
} from "../services/employee.mediaService.js";
import { uploadFileToDAM, getDamAssetById } from "../services/dam.media.service.js";

// CREATE
export const createEmployeeMedia = async (req, res) => {
    try {

        const files = req.files; // Important fix

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No files uploaded"
            });
        }

        // 1️⃣ Upload each file to DAM and return array of results
        const uploadedFiles = await Promise.all(
            files.map(async (file) => {
                const damResponse = await uploadFileToDAM(file);

                return {
                    media_id: damResponse?.[0]?.id,
                };
            })
        );
        // 2️⃣ Fetch DAM metadata for each uploaded file
        const fetchedMediaRecords = await Promise.all(uploadedFiles.map(async ({ media_id }) => {
            const record = await getDamAssetById(media_id);
            return { media_id, damMedia: record, };
        })
        );


        const result = await createEmployeeMediaService(req.body, fetchedMediaRecords);
        res.status(201).json({ success: true, data: result });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

// GET ALL
export const getAllEmployeeMedia = async (req, res) => {
    try {
        const data = await getAllEmployeeMediaService();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// GET BY ID
export const getEmployeeMediaById = async (req, res) => {
    try {
        const data = await getEmployeeMediaByIdService(req.params.id);
        res.json({ success: true, data });
    } catch (err) {
        res.status(404).json({ success: false, message: err.message });
    }
};

// UPDATE
export const updateEmployeeMedia = async (req, res) => {
    try {
        const data = await updateEmployeeMediaService(req.params.id, req.body, req.files);
        res.json({ success: true, data });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
};

// DELETE
export const deleteEmployeeMedia = async (req, res) => {
    try {
        const data = await deleteEmployeeMediaService(req.params.id);
        res.json({ success: true, data });
    } catch (err) {
        res.status(404).json({ success: false, message: err.message });
    }
};
