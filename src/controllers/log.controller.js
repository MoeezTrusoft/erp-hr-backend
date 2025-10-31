import * as logService from "../services/log.service.js";

export const getAll = async (req, res) => {
  try {
       let ip =
            req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const logs = await logService.getAllLogs(req.user.id, ip);
    res.status(200).json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getById = async (req, res) => {
  try {
       let ip =
            req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const log = await logService.getLogById(req.params.id,req.user.id,ip);
    if (!log) {
      return res.status(404).json({ success: false, message: "Log not found" });
    }
    res.status(200).json({ success: true, data: log });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
