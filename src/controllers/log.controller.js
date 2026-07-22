import * as logService from "../services/log.service.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped audit-log service so a tenant never reads another tenant's audit trail.
const tenantOf = (req) => req.user?.tenantId;

export const getAll = async (req, res) => {
  try {
       let ip =
            req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const logs = await logService.getAllLogs(req.user.id, ip, tenantOf(req));
    res.status(200).json({ success: true, data: logs });
  } catch (err) {
    respondServerError(req, res, err);
  }
};

export const getById = async (req, res) => {
  try {
       let ip =
            req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const log = await logService.getLogById(req.params.id, req.user.id, ip, tenantOf(req));
    if (!log) {
      return res.status(404).json({ success: false, message: "Log not found" });
    }
    res.status(200).json({ success: true, data: log });
  } catch (err) {
    respondServerError(req, res, err);
  }
};
