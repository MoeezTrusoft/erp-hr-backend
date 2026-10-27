import { requireRecruitmentActor } from "../services/recruitmentActor.service.js";
// Privacy administration is restricted to verified HR administrators; the
// candidate-owned public routes authorize their own mailbox-scoped operations.
export async function requireCandidatePrivacyAdmin(req, res, next) {
  try {
    const action = {
      GET: "read",
      HEAD: "read",
      POST: "create",
      PUT: "update",
      PATCH: "update",
      DELETE: "delete",
    }[req.method];
    if (!action)
      return res
        .status(403)
        .json({
          success: false,
          code: "HR-5304",
          message: "Privacy operation is not permitted",
        });
    const { who } = await requireRecruitmentActor({
      tenantId: req.user?.tenantId,
      permission: "hr.recruitment." + action,
      allowedScopes: ["ORG"],
      adminOnly: true,
    });
    req.recruitmentPrivacyActor = who;
    return next();
  } catch (error) {
    return res
      .status(error.status || 403)
      .json({
        success: false,
        code: error.code || "HR-5304",
        message: error.message,
      });
  }
}
