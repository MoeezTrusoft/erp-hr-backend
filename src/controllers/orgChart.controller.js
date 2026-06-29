import * as svc from "../services/orgChart.service.js";

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped org-chart service so a tenant's chart never includes another tenant's
// employees.
const tenantOf = (req) => req.user?.tenantId;

export const getOrgChart = async (req, res) => {
  try {
    const data = await svc.getOrgChart(tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

export const getOrgSubtree = async (req, res) => {
  try {
    const data = await svc.getOrgSubtree(req.params.employeeId, tenantOf(req));
    if (!data) return res.status(404).json({ success: false, message: "Not found" });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
