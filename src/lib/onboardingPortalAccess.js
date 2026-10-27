import { currentRequestContext } from './requestContext.js';
import { hasPermission, METHOD_ACTION } from './assertPermission.js';
import { rolesOf } from './recruitmentAccess.js';
import { AppError } from '../utils/AppError.js';

const HR_ROLES = ['HR_ADMIN', 'HR_MANAGER', 'HR_HEAD', 'RECRUITER', 'TA_RECRUITER', 'TALENT_ACQUISITION'];
// Resource grants and row access are independent. An administrator claim is
// never an alternative to a grant; self-service cannot unlock HR management.
export function onboardingPortalAccess(method = 'GET', { selfAllowed = false, tenantId } = {}) {
  const ctx = currentRequestContext() ?? {};
  if (!ctx.actorVerified || !ctx.user?.tenantId || (tenantId && tenantId !== ctx.user.tenantId))
    throw new AppError('Verified employee and company required', 401);
  if (ctx.user.isAutomation || ctx.user.tokenClaims?.act?.type === 'automation')
    throw new AppError('An employee must perform this action', 403);
  const hr = rolesOf(ctx.user).some(role => HR_ROLES.includes(role)) &&
    hasPermission(ctx.permissions, 'hr:onboarding', METHOD_ACTION[method]);
  const self = selfAllowed && (hasPermission(ctx.permissions, 'hr:self', 'VIEW') ||
    (rolesOf(ctx.user).some(role => HR_ROLES.includes(role)) && hasPermission(ctx.permissions, 'hr:onboarding', 'VIEW')));
  if (!hr && !self) throw new AppError('Onboarding permission required', 403);
  return { ctx, tenantId: ctx.user.tenantId, hr };
}
