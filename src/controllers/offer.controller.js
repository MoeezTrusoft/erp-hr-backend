import * as svc from "../services/offer.service.js";

export const createOffer = async (req, res) => {
    try {
        const createdById = req.headers["x-employee-id"];
        const result = await svc.createOffer({ ...req.body, createdById });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getOffer = async (req, res) => {
    try {
        const result = await svc.getOffer(req.params.id);
        if (!result) return res.status(404).json({ success: false, message: "Not found" });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listOffers = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listOffers({ page: Number(page) || 1, limit: Number(limit) || 20 });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

export const sendOffer = async (req, res) => {
    try {
        const result = await svc.sendOffer(req.params.id);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const respondOffer = async (req, res) => {
    try {
        const { accepted } = req.body;
        const result = await svc.respondOffer(req.params.id, accepted);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const uploadOfferLetter = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const result = await svc.uploadOfferLetter(req.params.id, req.files[0]);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
