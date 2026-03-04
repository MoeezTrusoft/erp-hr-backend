import * as svc from "../services/self.service.js";

export const getSelfProfile = async (req, res) => {
  try {
    const data = await svc.getSelfProfile(req);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const updateSelfProfile = async (req, res) => {
  try {
    const data = await svc.updateSelfProfile(req);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listSelfEmergencyContacts = async (req, res) => {
  try {
    const data = await svc.listSelfEmergencyContacts(req);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const upsertSelfEmergencyContact = async (req, res) => {
  try {
    const data = await svc.upsertSelfEmergencyContact(req);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listSelfPayslips = async (req, res) => {
  try {
    const data = await svc.listSelfPayslips(req);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listSelfLeaveBalances = async (req, res) => {
  try {
    const data = await svc.listSelfLeaveBalances(req);
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
