import {
  saveDashboardLayout,
 // getDashboardLayout
} from "../services/dashboardLayout.service.js";
import { respondServerError } from '../utils/httpError.js';

export const saveLayoutController = async (req, res) => {
  try {
     const employeeId = req.headers["user-id"];
    const { dashboardType = "workforce", layout } = req.body;

    if (!employeeId || !layout) {
      return res.status(400).json({
        success: false,
        message: "EmployeeId and layout are required"
      });
    }

    // C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded in
    // so a tenant never overwrites/reads another tenant's saved layout.
    const data = await saveDashboardLayout(
      employeeId,
      dashboardType,
      layout,
      req.user?.tenantId
    );

    res.json({
      success: true,
      message: "Dashboard layout saved",
      data
    });

  } catch (error) {
    respondServerError(req, res, error);
  }
};

// export const getLayoutController = async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const { dashboardType = "workforce" } = req.query;

//     const data = await getDashboardLayout(userId, dashboardType);

//     res.json({
//       success: true,
//       data
//     });

//   } catch (error) {
//     respondServerError(req, res, error);
//   }
// };