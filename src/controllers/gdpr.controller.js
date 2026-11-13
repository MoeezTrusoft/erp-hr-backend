import * as svc from "../services/gdpr.service.js";

// HR-SEC-07 — the GDPR export/erase surface is scoped to the VERIFIED tenant on
// req.user.tenantId (set by internalServiceGuard from the service-JWT claim —
// T-P2.1). NEVER read tenant from req.headers / x-tenant-id. A wrong-tenant id
// resolves to not-found in the service (statusCode 404) and never acts on data.
const tenantOf = (req) => req.user?.tenantId ?? null;

export const exportData = async (req, res) => {
  try {
    const data = await svc.exportEmployeeData(req.params.employeeId, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    const status = e.statusCode || 400;
    res.status(status).json({ success: false, message: e.message, requestId: req.requestId });
  }
};

export const eraseData = async (req, res) => {
  try {
    const data = await svc.eraseEmployeeData(req.params.employeeId, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    const status = e.statusCode || 400;
    res.status(status).json({ success: false, message: e.message, requestId: req.requestId });
  }
};
