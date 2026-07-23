import * as svc from "../services/certification.service.js";
import { respondServerError } from '../utils/httpError.js';

export const createCertification = async (req, res) => {
    try {
        const result = await svc.createCertification(req.body);
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listCertifications = async (req, res) => {
    try {
        const { employeeId, page, limit } = req.query;
        const result = await svc.listCertifications({ employeeId, page: Number(page) || 1, limit: Number(limit) || 20 });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { respondServerError(req, res, e); }
};

export const getCertification = async (req, res) => {
    try {
        const result = await svc.getCertification(req.params.id);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(404).json({ success: false, message: e.message }); }
};

export const updateCertification = async (req, res) => {
    try {
        const result = await svc.updateCertification(req.params.id, req.body);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const deleteCertification = async (req, res) => {
    try {
        await svc.deleteCertification(req.params.id);
        res.status(204).end();
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const uploadCertificateFile = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const result = await svc.uploadCertificateFile(req.params.id, req.files[0]);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getTranscript = async (req, res) => {
    try {
        const result = await svc.getTranscript(req.params.employeeId);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
