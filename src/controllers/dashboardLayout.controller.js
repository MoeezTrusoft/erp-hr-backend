import {
  saveDashboardLayout,
 // getDashboardLayout
} from "../services/dashboardLayout.service.js";

export const saveLayoutController = async (req, res) => {
  try {
     const employeeId = req.headers["user-id"];
    const { dashboardType = "workforce", layout } = req.body;
console.log(employeeId);

    if (!employeeId || !layout) {
      return res.status(400).json({
        success: false,
        message: "EmployeeId and layout are required"
      });
    }

    const data = await saveDashboardLayout(
      employeeId,
      dashboardType,
      layout
    );

    res.json({
      success: true,
      message: "Dashboard layout saved",
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
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
//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   }
// };