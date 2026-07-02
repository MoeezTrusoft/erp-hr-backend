// src/lib/rlsTenant.js — FORCE ROW LEVEL SECURITY tenant-context extension.
//
// The c2_rls_pilot migration puts FORCE RLS on Attendance / LeaveRequest /
// PerformanceReview with the policy
//     USING/CHECK (tenantId = public.hr_current_tenant())
// where hr_current_tenant() = current_setting('app.tenant_id', true)::uuid.
//
// So every read/write of those tables must run with app.tenant_id set to the
// VERIFIED request tenant (the RBAC Company uuid on user.tenantId, never a
// spoofable header). We wrap each such operation in a transaction that sets the
// GUC transaction-locally via set_config(..., true) and runs the operation in
// the SAME transaction (a batch $transaction shares one connection). Non-RLS
// models and tenant-less contexts (jobs) are passed straight through.
import { mcpCtx } from '../mcp/context.js';

const RLS_MODELS = new Set(['Attendance', 'LeaveRequest', 'PerformanceReview']);
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rlsTenantExtension = (client) =>
    client.$extends({
        name: 'rls-tenant-guc',
        query: {
            $allModels: {
                async $allOperations({ model, args, query }) {
                    const tenantId = mcpCtx.getStore()?.user?.tenantId;
                    if (
                        !RLS_MODELS.has(model) ||
                        !tenantId ||
                        !UUID_RE.test(String(tenantId))
                    ) {
                        return query(args);
                    }
                    const [, result] = await client.$transaction([
                        client.$executeRaw`SELECT set_config('app.tenant_id', ${String(
                            tenantId,
                        )}, true)`,
                        query(args),
                    ]);
                    return result;
                },
            },
        },
    });
